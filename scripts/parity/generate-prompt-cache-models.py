#!/usr/bin/env python3
"""Generate native OpenAI cache-key capabilities from the pinned Python runtime.

Run with the pinned checkout's locked .venv Python and its exact LiteLLM sdist.
Exact model evidence and structurally model-independent provider defaults are generated.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import io
import textwrap
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import socket
import tomllib

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["OPENHANDS_SUPPRESS_BANNER"] = "1"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def preserve_key_filters(tree):
    """Erase only list filters proven unable to remove the queried key."""
    constants = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if sum(isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Store) for n in ast.walk(tree)) == 1:
                try:
                    constants[name] = ast.literal_eval(node.value)
                except (ValueError, TypeError):
                    pass
    parents = {id(child): parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    for name in list(constants):
        for usage in ast.walk(tree):
            if isinstance(usage, ast.Name) and usage.id == name and isinstance(usage.ctx, ast.Load):
                parent = parents.get(id(usage))
                if not (isinstance(parent, ast.Compare) and usage in parent.comparators):
                    constants.pop(name, None)
                    break
    def safe_filter(condition, name):
        if not (isinstance(condition, ast.Compare) and len(condition.ops) == 1 and isinstance(condition.left, ast.Name) and condition.left.id == name):
            return False
        rhs = condition.comparators[0]
        try:
            excluded = constants[rhs.id] if isinstance(rhs, ast.Name) else ast.literal_eval(rhs)
        except (ValueError, TypeError, KeyError):
            return False
        if isinstance(condition.ops[0], ast.NotEq):
            return isinstance(excluded, str) and excluded != "prompt_cache_key"
        return isinstance(condition.ops[0], ast.NotIn) and isinstance(excluded, (list, tuple)) and all(isinstance(item, str) for item in excluded) and "prompt_cache_key" not in excluded
    def assigned(statement):
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            return statement.targets[0].id
        return None
    class Normalize(ast.NodeTransformer):
        def visit_Assign(self, node):
            name = assigned(node)
            comp = node.value
            if isinstance(comp, ast.ListComp) and len(comp.generators) == 1:
                generator = comp.generators[0]
                if (isinstance(generator.target, ast.Name) and isinstance(generator.iter, ast.Name) and generator.iter.id == name
                        and isinstance(comp.elt, ast.Name) and comp.elt.id == generator.target.id and not generator.is_async
                        and generator.ifs and all(safe_filter(test, generator.target.id) for test in generator.ifs)):
                    return ast.Pass()
            return self.generic_visit(node)
        def visit_If(self, node):
            body = node.body
            if len(body) == 3 and assigned(body[0]) and isinstance(body[0].value, ast.List) and not body[0].value.elts and isinstance(body[1], ast.For):
                filtered, loop, final = assigned(body[0]), body[1], body[2]
                if (isinstance(loop.target, ast.Name) and isinstance(loop.iter, ast.Name) and not loop.orelse
                        and assigned(final) == loop.iter.id and isinstance(final.value, ast.Name) and final.value.id == filtered
                        and len(loop.body) == 1 and isinstance(loop.body[0], ast.If)):
                    branch = loop.body[0]
                    if not branch.orelse and len(branch.body) == 1 and safe_filter(branch.test, loop.target.id):
                        action = branch.body[0]
                        call = action.value if isinstance(action, ast.Expr) else None
                        if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
                                and call.func.value.id == filtered and call.func.attr == "append" and not call.keywords
                                and len(call.args) == 1 and isinstance(call.args[0], ast.Name) and call.args[0].id == loop.target.id):
                            node.body = [ast.Pass()]
            return self.generic_visit(node)
    return Normalize().visit(tree)


def invariant_cache_key(cls: type, evidence: dict[str, str], guards=None, overrides=None, receiver=None) -> bool | None:
    """Prove a narrow list-building subset; unsupported/model-dependent code stays unknown.

    A literal list, inherited list, additive append/extend, concatenation and
    de-duplication cannot drop a guaranteed key. No probing a synthetic model is
    treated as a universal provider proof.
    """
    if overrides and cls in overrides:
        return overrides[cls]
    actual_receiver = receiver or cls
    hierarchy = actual_receiver.__mro__[actual_receiver.__mro__.index(cls):]
    owner = next((base for base in hierarchy if "get_supported_openai_params" in base.__dict__), None)
    if owner is None:
        return None
    method = owner.__dict__["get_supported_openai_params"]
    if isinstance(method, (classmethod, staticmethod)):
        method = method.__func__
    try:
        source = textwrap.dedent(inspect.getsource(method))
    except (TypeError, OSError):
        return None
    evidence[f"{owner.__module__}.{owner.__name__}.get_supported_openai_params"] = digest(source.encode())
    tree = ast.parse(source).body[0]
    if guards:
        class ChooseGuard(ast.NodeTransformer):
            def visit_If(self, node):
                test = node.test
                if (isinstance(test, ast.Call) and isinstance(test.func, ast.Attribute) and isinstance(test.func.value, ast.Name)
                        and test.func.value.id == "self" and test.func.attr in guards):
                    return [self.visit(item) for item in (node.body if guards[test.func.attr] else node.orelse)]
                return self.generic_visit(node)
        tree = ChooseGuard().visit(tree)
        for index, statement in enumerate(tree.body):
            if isinstance(statement, ast.Return):
                tree.body = tree.body[:index + 1]
                break
    tree = preserve_key_filters(tree)
    assignments = {}
    for statement in ast.walk(tree):
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            assignments[statement.targets[0].id] = statement.value
        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            assignments[statement.target.id] = statement.value
    resolving = set()
    def union(a, b):
        return True if a is True or b is True else False if a is False and b is False else None
    def value(node):
        if isinstance(node, ast.ListComp) and len(node.generators) == 1:
            generator = node.generators[0]
            if (isinstance(generator.target, ast.Name) and isinstance(node.elt, ast.Name) and node.elt.id == generator.target.id
                    and not generator.is_async and len(generator.ifs) == 1):
                test = generator.ifs[0]
                if (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.NotIn)
                        and isinstance(test.left, ast.Name) and test.left.id == generator.target.id and value(test.comparators[0]) is False):
                    return value(generator.iter)
        if isinstance(node, (ast.List, ast.Tuple)):
            if all(isinstance(item, ast.Constant) for item in node.elts):
                return any(item.value == "prompt_cache_key" for item in node.elts)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return union(value(node.left), value(node.right))
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr == "get_supported_openai_params" and isinstance(node.func.value, ast.Call) and isinstance(node.func.value.func, ast.Name) and node.func.value.func.id == "super":
                call = node.func.value
                start = owner
                if call.args:
                    if (len(call.args) != 2 or not isinstance(call.args[0], ast.Name)
                            or not isinstance(call.args[1], ast.Name) or call.args[1].id != "self"):
                        return None
                    start = method.__globals__.get(call.args[0].id)
                if start not in actual_receiver.__mro__ or call.keywords:
                    return None
                remaining = actual_receiver.__mro__[actual_receiver.__mro__.index(start) + 1:]
                return invariant_cache_key(remaining[0], evidence, guards, overrides, actual_receiver) if remaining else None
            if (isinstance(node.func, ast.Attribute) and node.func.attr == "get_supported_openai_params"
                    and isinstance(node.func.value, ast.Name)):
                target = method.__globals__.get(node.func.value.id)
                if isinstance(target, type) and target is not owner:
                    return invariant_cache_key(target, evidence, guards, overrides)
            if (isinstance(node.func, ast.Attribute) and node.func.attr == "get_supported_openai_params"
                    and isinstance(node.func.value, ast.Call)):
                constructor = node.func.value.func
                target = method.__globals__.get(constructor.id) if isinstance(constructor, ast.Name) else None
                if isinstance(constructor, ast.Attribute) and isinstance(constructor.value, ast.Name):
                    target = getattr(method.__globals__.get(constructor.value.id), constructor.attr, None)
                if isinstance(target, type) and target is not owner:
                    return invariant_cache_key(target, evidence, guards, overrides)
            if isinstance(node.func, ast.Name) and node.func.id == "list" and len(node.args) == 1:
                return value(node.args[0])
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == "dict" and node.func.attr == "fromkeys" and len(node.args) == 1:
                return value(node.args[0])
        if isinstance(node, ast.Name) and node.id in assignments and node.id not in resolving:
            name = node.id
            # A second assignment, subscript write or destructive method invalidates proof.
            if sum(isinstance(item, ast.Name) and item.id == name and isinstance(item.ctx, ast.Store) for item in ast.walk(tree)) != 1:
                return None
            resolving.add(name)
            result = value(assignments[name])
            # A filter may remove only a statically bounded set of other params
            # (Moonshot drops functions, and sometimes tools/tool_choice).
            for loop in tree.body:
                if not isinstance(loop, ast.For) or not isinstance(loop.target, ast.Name) or len(loop.body) != 1 or loop.orelse:
                    continue
                branch = loop.body[0]
                if not isinstance(branch, ast.If) or branch.orelse or len(branch.body) != 1:
                    continue
                condition = branch.test
                action = branch.body[0]
                if not (isinstance(condition, ast.Compare) and len(condition.ops) == 1 and isinstance(condition.ops[0], ast.NotIn)
                        and isinstance(condition.left, ast.Name) and condition.left.id == loop.target.id
                        and isinstance(action, ast.Expr) and isinstance(action.value, ast.Call)):
                    continue
                call = action.value
                if (isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == name
                        and call.func.attr == "append" and len(call.args) == 1 and isinstance(call.args[0], ast.Name)
                        and call.args[0].id == loop.target.id and value(loop.iter) is True and value(condition.comparators[0]) is False):
                    result = True
            for item in ast.walk(tree):
                if isinstance(item, ast.Call) and any(isinstance(child, ast.Name) and child.id == name for argument in [*item.args, *(keyword.value for keyword in item.keywords)] for child in ast.walk(argument)):
                    pure_copy = isinstance(item.func, ast.Name) and item.func.id in ("list", "tuple", "set", "frozenset")
                    pure_dedupe = isinstance(item.func, ast.Attribute) and isinstance(item.func.value, ast.Name) and item.func.value.id == "dict" and item.func.attr == "fromkeys"
                    receiver = assignments.get(item.func.value.id) if isinstance(item.func, ast.Attribute) and isinstance(item.func.value, ast.Name) else None
                    list_extension = (isinstance(item.func, ast.Attribute) and item.func.attr == "extend" and
                                      (isinstance(receiver, ast.List) or isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Attribute) and receiver.func.attr == "get_supported_openai_params"))
                    if not (pure_copy or pure_dedupe or list_extension):
                        result = None
                        break
                if isinstance(item, (ast.Assign, ast.AnnAssign)) and item.value is not assignments[name] and item.value is not None and any(isinstance(child, ast.Name) and child.id == name for child in ast.walk(item.value)):
                    result = None
                    break
                if isinstance(item, ast.Subscript) and isinstance(item.value, ast.Name) and item.value.id == name and isinstance(item.ctx, (ast.Store, ast.Del)):
                    result = None
                    break
                if isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute) and isinstance(item.func.value, ast.Name) and item.func.value.id == name:
                    if (item.func.attr == "remove" and len(item.args) == 1 and isinstance(item.args[0], ast.Constant)
                            and isinstance(item.args[0].value, str) and item.args[0].value != "prompt_cache_key"):
                        continue
                    if item.func.attr == "remove" and len(item.args) == 1 and isinstance(item.args[0], ast.Name):
                        variable = item.args[0].id
                        stores = sum(isinstance(child, ast.Name) and child.id == variable and isinstance(child.ctx, ast.Store) for child in ast.walk(tree))
                        loops = [child for child in ast.walk(tree) if isinstance(child, ast.For) and isinstance(child.target, ast.Name)
                                 and child.target.id == variable and any(n is item for n in ast.walk(child))]
                        if stores == 1 and len(loops) == 1 and value(loops[0].iter) is False:
                            continue
                    if item.func.attr not in ("append", "extend") or len(item.args) != 1:
                        result = None
                        break
                    addition = item.args[0]
                    if item.func.attr == "append":
                        addition = ast.List(elts=[addition])
                    extra = value(addition)
                    # Conditional additions prove absence only when they cannot add the key.
                    result = result if result is True or extra is False else None
            resolving.remove(name)
            return result
        return None
    results = [value(item.value) for item in ast.walk(tree) if isinstance(item, ast.Return)]
    return results[0] if results and results[0] is not None and all(item == results[0] for item in results) else None


def class_program(cls, evidence):
    result = invariant_cache_key(cls, evidence)
    if result is not None:
        return ["value", result]
    for owner in cls.__mro__:
        method = owner.__dict__.get("get_supported_openai_params")
        if method is None:
            continue
        for branch in ast.walk(ast.parse(textwrap.dedent(inspect.getsource(method)))):
            test = branch.test if isinstance(branch, ast.If) else None
            if not (isinstance(test, ast.Call) and isinstance(test.func, ast.Attribute) and isinstance(test.func.value, ast.Name)
                    and test.func.value.id == "self"):
                continue
            name = test.func.attr
            yes, no = (invariant_cache_key(cls, evidence, {name: answer}) for answer in (True, False))
            if yes is not None and no is not None:
                return ["if", compile_selector(getattr(cls, name), evidence), ["value", yes], ["value", no]]
    for parent in cls.__mro__[1:]:
        if not hasattr(parent, "get_supported_openai_params"):
            continue
        yes, no = (invariant_cache_key(cls, evidence, overrides={parent: answer}) for answer in (True, False))
        if yes is True and no is False:
            return class_program(parent, evidence)
    # Some base handlers are pure dispatch to other handlers rather than list builders.
    return compile_selector(cls.get_supported_openai_params, evidence)


def compile_selector(function, evidence, bindings=None):
    """Compile a bounded, pure model-dispatch AST into data, never provider switches."""
    source = textwrap.dedent(inspect.getsource(function))
    evidence[f"{function.__module__}.{function.__qualname__}"] = digest(source.encode())
    tree = ast.parse(source).body[0]
    namespace = dict(function.__globals__)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported = __import__(node.module, fromlist=[item.name for item in node.names])
            namespace.update({item.asname or item.name: getattr(imported, item.name) for item in node.names})
    def resolve(node):
        if isinstance(node, ast.Name) and node.id in namespace:
            return namespace[node.id]
        if isinstance(node, ast.Attribute):
            return getattr(resolve(node.value), node.attr)
        if isinstance(node, ast.Call):
            return resolve(node.func)
        raise ValueError("Unsupported selector reference: " + ast.dump(node))
    def capability(node):
        if isinstance(node, (ast.Name, ast.Attribute)):
            instance = resolve(node)
            return class_program(instance if isinstance(instance, type) else type(instance), evidence)
        if not isinstance(node, ast.Call):
            raise ValueError("Expected a config constructor")
        if isinstance(node.func, ast.Attribute) and node.func.attr == "get_supported_openai_params":
            target = resolve(node.func)
            instance = target.__self__
            return class_program(instance if isinstance(instance, type) else type(instance), evidence)
        cls = resolve(node.func)
        if not isinstance(cls, type):
            raise ValueError("Expected a config class")
        return class_program(cls, evidence)
    returns = [node.value for node in ast.walk(tree) if isinstance(node, ast.Return)]
    try:
        values = [capability(node) for node in returns]
        if values and all(value == values[0] for value in values):
            return values[0]
    except ValueError:
        pass
    def expression(node, env):
        if isinstance(node, ast.JoinedStr):
            parts = []
            for item in node.values:
                part = expression(item.value, env) if isinstance(item, ast.FormattedValue) else expression(item, env)
                if part[0] != "value" or not isinstance(part[1], str) or isinstance(item, ast.FormattedValue) and (item.conversion != -1 or item.format_spec is not None):
                    raise ValueError("Only generation-time literal selector formatting is supported")
                parts.append(part[1])
            return ["value", "".join(parts)]
        if isinstance(node, ast.Constant):
            return ["value", node.value]
        if isinstance(node, ast.Name) and node.id in env:
            return env[node.id]
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            operation = {ast.In: "in", ast.Eq: "eq", ast.Gt: "gt"}.get(type(node.ops[0]))
            if operation:
                return [operation, expression(node.left, env), expression(node.comparators[0], env)]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return ["not", expression(node.operand, env)]
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "split" and ast.literal_eval(node.slice) == -1:
            return ["last", expression(node.value.func.value, env), expression(node.value.args[0], env)]
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            return ["at", expression(node.value, env), ["value", node.slice.value]]
        if isinstance(node, ast.BoolOp):
            return ["or" if isinstance(node.op, ast.Or) else "and", *[expression(value, env) for value in node.values]]
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr == "get_supported_openai_params":
                return capability(node)
            if isinstance(node.func, ast.Name) and node.func.id == "len":
                return ["length", expression(node.args[0], env)]
            if isinstance(node.func, ast.Attribute) and node.func.attr == "isdigit":
                return ["digits", expression(node.func.value, env)]
            if isinstance(node.func, ast.Attribute) and node.func.attr == "lower" and not node.args and not node.keywords:
                return ["lower", expression(node.func.value, env)]
            if isinstance(node.func, ast.Attribute) and node.func.attr == "startswith" and len(node.args) == 1:
                return ["starts", expression(node.func.value, env), expression(node.args[0], env)]
            target = resolve(node.func)
            if isinstance(target, type):
                return capability(node)
            arguments = [*node.args, *(item.value for item in node.keywords)]
            if (inspect.isfunction(target) or inspect.ismethod(target)) and len(arguments) == 1:
                return compile_selector(target, evidence)
        if isinstance(node, (ast.Name, ast.Attribute)):
            constant = resolve(node)
            if isinstance(constant, (str, list, tuple, set, frozenset)) and all(isinstance(item, str) for item in constant):
                return ["value", sorted(constant) if isinstance(constant, (set, frozenset)) else constant]
        raise ValueError("Unsupported selector expression: " + ast.dump(node))
    def block(statements, env):
        if not statements:
            raise ValueError("Selector has an implicit return")
        first, *rest = statements
        if isinstance(first, (ast.ImportFrom, ast.Pass)) or isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
            return block(rest, env)
        if isinstance(first, ast.Assign) and len(first.targets) == 1 and isinstance(first.targets[0], ast.Name):
            return block(rest, {**env, first.targets[0].id: expression(first.value, env)})
        if isinstance(first, ast.Return):
            return expression(first.value, env)
        if isinstance(first, ast.If):
            return ["if", expression(first.test, env), block(first.body + rest, dict(env)), block(first.orelse + rest, dict(env))]
        raise ValueError("Unsupported selector statement: " + ast.dump(first))
    defaults = {argument.arg: ["value", ast.literal_eval(value)] for argument, value in zip(tree.args.args[-len(tree.args.defaults):], tree.args.defaults)} if tree.args.defaults else {}
    return block(tree.body, {**defaults, "model": ["model"], **(bindings or {})})


def compile_bedrock(evidence):
    """Generate data for the reviewed native normalizer, failing if its source changes.

    This is deliberately a small native port, not a general Python interpreter.
    Hash guards bind its control flow to the reviewed locked methods; all provider,
    route, region and registry data and handler capabilities come from that source.
    """
    import litellm
    from typing import get_args
    from litellm.llms.bedrock import common_utils as common
    from litellm.llms.bedrock.base_aws_llm import BaseAWSLLM
    from litellm.constants import BEDROCK_INVOKE_PROVIDERS_LITERAL
    reviewed = {
        'get_bedrock_base_model': 'd160c1167ae51aea3f24506110ee0115d9a0ba7183f043514e14fd39d4beef2e',
        'extract_model_name_from_bedrock_arn': '43106266fc685613fc4df4bf92cb446440c3928f8bf50f1f7c90174751c1d86b',
        'strip_bedrock_routing_prefix': 'bc2c1aa77937abaac4d8e5c42ce17c7a95c3f8c3c331244d024fc6fefcb0841d',
        'strip_bedrock_throughput_suffix': '200295fd15b30c97f5e193d14245e6678bae664aba5f642af0790b2d15539917',
        'is_bedrock_application_inference_profile_arn': 'b8f00d86a5272f2d24b4823b3449ea26e6355b9d154bf32da5b57f02dc067c7f',
        'BedrockModelInfo.get_bedrock_route': '409efe24e39238fb84b70c89a79392d4390255c6f3b0cec2699f7e6b4d7175a7',
        'BedrockModelInfo.get_base_model': 'a37e0946690dfe6e6b945a9cba23e55ab4ee5612ae0c23e5abde5896df9687b7',
        'BedrockModelInfo.get_non_litellm_routing_model_name': 'a6930095d7b1d4f2655e91f52f492b8d702ddb9e6973d549488ef702df515e2d',
        'BedrockModelInfo._model_has_route_prefix': '8ad95aafec65f1477dc293800e7e564d8c45cd51e1742726474f646d3d7d9516',
        'get_bedrock_chat_config': 'f83ca6995ab0637af9f38fcef4326f2f4fbe9202b127ff11f9636d6a7ca2710b',
        'BaseAWSLLM.get_bedrock_invoke_provider': 'e8d971210de625d60cbf330ff4e805edcc9a130ed2de7d4367ce50acd70f4502',
        'BaseAWSLLM._get_provider_from_model_path': '2ec298b4c7c85a160ef769019e51470f91b1fdd1bbd8554d7163d620c156990b',
    }
    trees = {}
    for name, expected in reviewed.items():
        parts = name.split('.')
        method = BaseAWSLLM if parts[0] == 'BaseAWSLLM' else getattr(common, parts[0])
        for part in parts[1:]:
            method = getattr(method, part)
        source = textwrap.dedent(inspect.getsource(method))
        actual = digest(source.encode())
        if actual != expected:
            raise ValueError(f'Review native Bedrock normalization before updating {name}')
        evidence[name] = actual
        trees[name] = ast.parse(source).body[0]
    def constants(method):
        source = textwrap.dedent(inspect.getsource(method))
        evidence[method.__qualname__] = digest(source.encode())
        return source
    regions = common.AmazonBedrockGlobalConfig()
    for name in ('get_all_regions', 'get_us_regions', 'get_eu_regions', 'get_ap_regions', 'get_ca_regions', 'get_sa_regions'):
        constants(getattr(regions, name))
    constants(common.get_bedrock_cross_region_inference_regions)
    # The literal preserves provider priority; sorting changes observable routing.
    providers = list(get_args(BEDROCK_INVOKE_PROVIDERS_LITERAL))
    evidence['BEDROCK_INVOKE_PROVIDERS_LITERAL'] = digest(json.dumps(providers).encode())
    route_tree = trees['BedrockModelInfo.get_bedrock_route']
    routes = ast.literal_eval(next(node.value for node in route_tree.body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == 'route_mappings'))
    def labels(test, variable):
        if (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)
                and isinstance(test.left, ast.Name) and test.left.id == variable and isinstance(test.comparators[0], ast.Constant)):
            return [test.comparators[0].value]
        if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.Or):
            return [label for item in test.values for label in labels(item, variable)]
        raise ValueError('Bedrock configuration selector changed shape')
    def capability(body):
        namespace = dict(common.get_bedrock_chat_config.__globals__)
        for node in ast.walk(ast.Module(body=body, type_ignores=[])):
            if isinstance(node, ast.ImportFrom):
                imported = __import__(node.module, fromlist=[item.name for item in node.names])
                namespace.update({item.asname or item.name: getattr(imported, item.name) for item in node.names})
        results = []
        for node in ast.walk(ast.Module(body=body, type_ignores=[])):
            if not isinstance(node, ast.Return):
                continue
            result = node.value
            if not isinstance(result, ast.Call) or result.args or result.keywords:
                raise ValueError('Bedrock config constructor changed shape')
            target = result.func
            cls = namespace[target.id] if isinstance(target, ast.Name) else getattr(namespace[target.value.id], target.attr)
            supported = invariant_cache_key(cls, evidence)
            if supported is None:
                raise ValueError(f'Unproved Bedrock handler: {cls.__name__}')
            method = ast.parse(textwrap.dedent(inspect.getsource(cls.get_supported_openai_params))).body[0]
            statements = [item for item in method.body if not (isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str))]
            empty = len(statements) == 1 and isinstance(statements[0], ast.Return) and isinstance(statements[0].value, ast.List) and not statements[0].value.elts
            results.append(None if empty else supported)
        if not results or any(item is not results[0] for item in results):
            raise ValueError('Bedrock branch requires model-dependent capability dispatch')
        return results[0]
    chains = [item for item in trees['get_bedrock_chat_config'].body if isinstance(item, ast.If)]
    def chain(branch, variable):
        outputs = {}
        while True:
            for label in labels(branch.test, variable):
                outputs[label] = capability(branch.body)
            if len(branch.orelse) == 1 and isinstance(branch.orelse[0], ast.If):
                branch = branch.orelse[0]
            else:
                return outputs, capability(branch.orelse) if branch.orelse else None
    route_capabilities, _ = chain(chains[0], 'bedrock_route')
    invoke_capabilities, default = chain(chains[1], 'bedrock_invoke_provider')
    strip_prefixes = ast.literal_eval(next(node.iter for node in trees['strip_bedrock_routing_prefix'].body if isinstance(node, ast.For)))
    nova_strip_prefixes = ast.literal_eval(next(node.iter for node in trees['get_bedrock_base_model'].body if isinstance(node, ast.For)))
    nova_models = {}
    for node in ast.walk(trees['get_bedrock_base_model']):
        if (isinstance(node, ast.If) and isinstance(node.test, ast.Call) and isinstance(node.test.func, ast.Attribute)
                and isinstance(node.test.func.value, ast.Name) and node.test.func.value.id == 'stripped' and isinstance(node.body[0], ast.Return)):
            nova_models[ast.literal_eval(node.test.args[0])] = ast.literal_eval(node.body[0].value)
    return {'routes': list(routes.items()), 'route_capabilities': route_capabilities,
            'strip_prefixes': strip_prefixes, 'nova_strip_prefixes': nova_strip_prefixes, 'nova_models': nova_models,
            'cross_regions': common.get_bedrock_cross_region_inference_regions(), 'regions': regions.get_all_regions(),
            'converse_models': sorted(set(litellm.bedrock_converse_models)), 'invoke_providers': providers,
            'invoke_capabilities': {provider: invoke_capabilities.get(provider, default) for provider in providers},
            'default_capability': default, 'method_sha256': dict(sorted(evidence.items()))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--litellm-archive", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    source = args.upstream.resolve()
    pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if head != pin or subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True).strip():
        raise ValueError("A clean checkout at the canonical full pin is required")
    lock_bytes = (source / "uv.lock").read_bytes()
    locked = next(item for item in tomllib.loads(lock_bytes.decode())["package"] if item["name"] == "litellm")
    archive_hash = digest(args.litellm_archive.read_bytes())
    if "sha256:" + archive_hash != locked["sdist"]["hash"]:
        raise ValueError("LiteLLM archive does not match the pinned lock")
    if importlib.metadata.version("litellm") != locked["version"]:
        raise ValueError("Installed LiteLLM version does not match the pinned lock")

    import litellm
    from openhands.sdk.llm.utils.model_features import get_features, _normalized_supported_openai_params, _normalize_model_for_litellm
    from openhands.sdk.llm.utils.verified_models import VERIFIED_OPENAI_MODELS, VERIFIED_MODELS
    from litellm.litellm_core_utils.fallback_generalizations import _registry
    import openhands.sdk.llm.utils.verified_models as verified

    sources = {"uv.lock": digest(lock_bytes)}
    for imported in (inspect.getfile(get_features), verified.__file__):
        path = Path(imported).resolve()
        if not path.is_relative_to(source):
            raise ValueError("Imported model capabilities are not from the pinned checkout")
        sources[str(path.relative_to(source))] = digest(path.read_bytes())
    package = Path(litellm.__file__).parent
    # Validate installed Python capability code and the local registry against
    # the hash-verified public sdist, without extracting or executing the archive.
    with tarfile.open(args.litellm_archive) as archive:
        for member in archive.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            if member.isfile() and relative.parts[0] == "litellm" and (relative.suffix == ".py" or relative.name == "model_prices_and_context_window_backup.json"):
                installed = package.parent / relative
                contents = archive.extractfile(member)
                if contents is None or not installed.is_file() or digest(installed.read_bytes()) != digest(contents.read()):
                    raise ValueError(f"Installed LiteLLM differs from locked sdist: {relative}")

    litellm.suppress_debug_info = True
    # Auth-backed routes initialize device-login machinery even during feature
    # discovery. They are outside this API-key capability artifact.
    auth_providers = {"chatgpt", "github_copilot"}
    pairs: set[tuple[str, str]] = set()
    models: set[str] = set()
    for name, info in litellm.model_cost.items():
        if not isinstance(info, dict) or info.get("mode") not in ("chat", "responses"):
            continue
        provider = info.get("litellm_provider")
        if not isinstance(provider, str) or provider in auth_providers or name.split("/")[0] in auth_providers:
            continue
        aliases = {name.lower(), name.removeprefix(provider + "/").lower(), name.rsplit("/", 1)[-1].lower()}
        models.update(aliases)
        pairs.update((alias, provider) for alias in aliases)
    for provider, names in VERIFIED_MODELS.items():
        models.update(name.lower() for name in names)
        models.update(f"{provider}/{name}".lower() for name in names)
        pairs.update((name.lower(), provider) for name in names)
    # Regression inputs are source-owned, not an independently maintained provider allowlist.
    tests_path = source / "tests/sdk/llm/test_model_features.py"
    tests = ast.parse(tests_path.read_text())
    regression_pairs = []
    for node in tests.body:
        if isinstance(node, ast.FunctionDef) and node.name == "test_prompt_cache_key_resolved_via_provider_hint":
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and len(decorator.args) > 1:
                    regression_pairs.extend(ast.literal_eval(decorator.args[1]))
    pairs.update(regression_pairs)
    models.update(model for model, _provider in regression_pairs)
    models = {_normalize_model_for_litellm(model) for model in models}
    unhinted = {}
    hinted: dict[str, dict[str, bool]] = {}
    regression = []
    defaults = {}
    dispatch = {}
    prefixes = {}
    unavailable = set()
    with contextlib.redirect_stdout(io.StringIO()):
        for model in sorted(models):
            params = _normalized_supported_openai_params(model)
            if params:
                unhinted[model] = get_features(model).supports_prompt_cache_key
        for model, provider in sorted(pairs):
            normalized = _normalize_model_for_litellm(model)
            try:
                if not _normalized_supported_openai_params(model):
                    hinted.setdefault(provider, {})[normalized] = get_features(model, model_info={"litellm_provider": provider}).supports_prompt_cache_key
            except ModuleNotFoundError as error:
                unavailable.add(error.name)
        for model, provider in regression_pairs:
            features = get_features(model, model_info={"litellm_provider": provider})
            regression.append({"model": model, "provider": provider, "cacheKey": features.supports_prompt_cache_key,
                               "reasoningEffort": features.supports_reasoning_effort})
        for provider, (factory, needs_model) in litellm.ProviderConfigManager._build_provider_config_map().items():
            if needs_model or provider.value in auth_providers | {"litellm_proxy", "openhands"}:
                continue
            try:
                config = factory()
            except ModuleNotFoundError as error:
                unavailable.add(error.name)
                continue
            evidence = {}
            invariant = invariant_cache_key(config if isinstance(config, type) else type(config), evidence)
            if invariant is not None:
                # Actual oracle still validates the structural result, never creates the proof.
                oracle = get_features("my-deployment", model_info={"litellm_provider": provider.value}).supports_prompt_cache_key
                if oracle != invariant:
                    continue
                defaults[provider.value] = {"supported": invariant, "method_sha256": dict(sorted(evidence.items()))}
    # Model-dependent dispatch is derived from the exact selector AST. The
    # handler proof records every method used; unsupported code fails generation.
    from litellm.llms.azure_ai.common_utils import AzureFoundryModelInfo
    selectors = {
        "openai": litellm.OpenAIConfig.get_supported_openai_params,
        "azure": litellm.ProviderConfigManager._get_azure_config,
        "azure_ai": AzureFoundryModelInfo.get_azure_ai_config_for_model,
        "vertex_ai": litellm.ProviderConfigManager._get_vertex_ai_config,
    }
    for provider, selector in selectors.items():
        evidence = {}
        dispatch[provider] = {"program": compile_selector(selector, evidence), "method_sha256": dict(sorted(evidence.items()))}
    evidence = {}
    bedrock = compile_bedrock(evidence)
    # Resolution evidence is separate from support: a known negative must not
    # fall through to a conflicting real-provider hint.
    with contextlib.redirect_stdout(io.StringIO()):
        for provider in sorted(litellm.provider_list):
            if provider in auth_providers | {"litellm_proxy", "openhands"}:
                continue
            try:
                params = _normalized_supported_openai_params(provider + "/my-deployment")
                if params:
                    prefixes[provider] = {"probe": provider + "/my-deployment", "supported": "prompt_cache_key" in params}
            except ModuleNotFoundError as error:
                unavailable.add(error.name)
    # Independent Bedrock dispatch probes also exercise these unhinted prefixes.
    # Unlike provider hints, a residual proxy prefix is not discarded by LiteLLM.
    # Prove the actual handlers; do not generalize from the synthetic alias alone.
    from litellm.types.utils import LlmProviders
    for provider in (LlmProviders.META, LlmProviders.LITELLM_PROXY):
        evidence = {}
        config = litellm.ProviderConfigManager.get_provider_chat_config(model=provider.value + "/my-deployment", provider=provider)
        invariant = invariant_cache_key(type(config), evidence)
        if invariant is None:
            raise ValueError(f"Unproved unhinted prefix capability: {provider.value}")
        params = litellm.get_supported_openai_params(model=provider.value + "/my-deployment")
        if not params or ("prompt_cache_key" in params) != invariant:
            raise ValueError("Unhinted prefix resolution changed")
        defaults[provider.value] = {"supported": invariant, "method_sha256": dict(sorted(evidence.items()))}
        prefixes[provider.value] = {"probe": provider.value + "/my-deployment", "supported": invariant}
    fixture_path = root / "src/llm/__tests__/fixtures/prompt-cache-provider-probes.json"
    fixture = json.loads(fixture_path.read_text())
    with contextlib.redirect_stdout(io.StringIO()):
        for row in fixture["cases"]:
            row.pop("expectedError", None)
            try:
                row["expected"] = get_features(row["model"], model_info={"litellm_provider": row["provider"]} if row["provider"] else None).supports_prompt_cache_key
            except IndexError:
                row.pop("expected", None)
                row["expectedError"] = "IndexError"
    fixture["upstreamCommit"] = pin
    fixture_path.write_text(json.dumps(fixture, indent=2) + "\n")
    sources[str(tests_path.relative_to(source))] = digest(tests_path.read_bytes())
    # Preserve the native provider-separated OpenAI catalog as an explicit fallback.
    openai_models = {name.removeprefix("openai/") for name, info in litellm.model_cost.items()
                     if isinstance(info, dict) and info.get("litellm_provider") == "openai" and info.get("mode") in ("chat", "responses")}
    supported = sorted(name for name in openai_models | set(VERIFIED_OPENAI_MODELS)
                       if get_features("openai/" + name).supports_prompt_cache_key)
    routing = [{"pattern": rule.pattern.pattern, "provider": rule.provider} for rule in _registry.routing_rules]
    provenance = {"upstream_commit": pin, "source_sha256": dict(sorted(sources.items())),
                  "unavailable_optional_modules": sorted(unavailable), "litellm_version": locked["version"], "litellm_sdist_sha256": archive_hash,
                  "model_map_sha256": digest((package / "model_prices_and_context_window_backup.json").read_bytes())}
    output = "// Generated by scripts/parity/generate-prompt-cache-models.py from pinned Python and locked LiteLLM.\n"
    output += "export const PROMPT_CACHE_KEY_PROVENANCE = " + json.dumps(provenance, indent=2) + " as const;\n\n"
    output += "export const PROMPT_CACHE_KEY_MODELS = " + json.dumps(supported, indent=2) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_UNHINTED: Readonly<Record<string, boolean>> = " + json.dumps(unhinted, indent=2, sort_keys=True) + ";\n"
    output += "\nexport const PROMPT_CACHE_KEY_HINTED: Readonly<Record<string, Readonly<Record<string, boolean>>>> = " + json.dumps({provider: dict(sorted(names.items())) for provider, names in sorted(hinted.items())}, indent=2) + ";\n"
    output += "\nexport const PROMPT_CACHE_KEY_PROVIDER_DEFAULTS = " + json.dumps(dict(sorted(defaults.items())), indent=2) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_ROUTING_RULES = " + json.dumps(routing, indent=2) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_PREFIX_RESOLUTION = " + json.dumps(prefixes, indent=2, sort_keys=True) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_PROVIDER_DISPATCH = " + json.dumps(dispatch, indent=2, sort_keys=True) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_BEDROCK = " + json.dumps(bedrock, indent=2) + " as const;\n"
    output += "\nexport const PROMPT_CACHE_KEY_REGRESSIONS = " + json.dumps(regression, indent=2) + " as const;\n"
    (root / "src/llm/prompt-cache-models.ts").write_text(output)
    print(f"Generated {len(unhinted)} resolved models, {sum(map(len, hinted.values()))} hinted pairs, {len(defaults)} proven provider defaults at {pin}")


if __name__ == "__main__":
    # Enforce offline generation even if a future dependency introduces I/O.
    def deny_network(*_args, **_kwargs):
        raise RuntimeError("Network access is disabled for capability generation")
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.getaddrinfo = deny_network
    # The dependency constructs a ChatGPT authenticator while listing params.
    # Isolate its directory before importing it; never inspect a real token store.
    with tempfile.TemporaryDirectory(prefix="cache-capability-oracle-") as temporary:
        os.environ["CHATGPT_TOKEN_DIR"] = str(Path(temporary) / "chatgpt")
        os.environ["GITHUB_COPILOT_TOKEN_DIR"] = str(Path(temporary) / "copilot")
        main()
