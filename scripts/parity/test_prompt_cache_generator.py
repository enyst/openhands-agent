"""Structural fallback proofs must not generalize a single model probe."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("cache_generator", pathlib.Path(__file__).with_name("generate-prompt-cache-models.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Base:
    def get_supported_openai_params(self, model):
        base = ["prompt_cache_key", "temperature"]
        extra = []
        if model == "reasoning":
            extra.append("reasoning_effort")
        return base + extra


class Additive(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        if model.startswith("special"):
            params.extend(["thinking"])
        return list(dict.fromkeys(params))


class Negative:
    def get_supported_openai_params(self, model):
        params = ["temperature"]
        if model.startswith("reasoning"):
            params.append("reasoning_effort")
        return params


class Conditional:
    def get_supported_openai_params(self, model):
        params = ["temperature"]
        if model == "only-this-one":
            params.append("prompt_cache_key")
        return params


class Removing(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        if model == "incompatible":
            params.remove("prompt_cache_key")
        return params


class Reassigning(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        if model == "incompatible":
            params = []
        return params


class Escaping(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        self.alter(params)
        return params


class Filtering(Base):
    def get_supported_openai_params(self, model):
        excluded = ["functions"]
        if model == "preview":
            excluded.extend(["tools", "tool_choice"])
        base = super().get_supported_openai_params(model)
        final = []
        for param in base:
            if param not in excluded:
                final.append(param)
        return final


class RemovingFilter(Base):
    def get_supported_openai_params(self, model):
        excluded = ["prompt_cache_key"]
        base = super().get_supported_openai_params(model)
        final = []
        for param in base:
            if param not in excluded:
                final.append(param)
        return final


class RemovingOther(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        try:
            params.remove("max_retries")
        except ValueError:
            pass
        return params


class FilterReassignment(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        if model == "special":
            filtered = []
            for param in params:
                if param != "tool_choice":
                    filtered.append(param)
            params = filtered
        if model == "other":
            params = [param for param in params if param != "stop"]
        return params


class UnsafeFilterReassignment(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        if model == "other":
            params = [param for param in params if param != "prompt_cache_key"]
        return params


class MutatedExclusion(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        excluded = ["stop"]
        excluded.append("prompt_cache_key")
        params = [param for param in params if param not in excluded]
        return params


class Branching:
    @staticmethod
    def search(model):
        return "search" in model

    def get_supported_openai_params(self, model):
        if self.search(model):
            return ["temperature"]
        return ["temperature", "prompt_cache_key"]


class PreserveBranch(Branching):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        params = [param for param in params if param != "stop"]
        return params


def route_prefix(model, prefix):
    return model.startswith(prefix) or f"/{prefix}" in model


class ExcludedParent(Base):
    def get_supported_openai_params(self, model):
        return ["temperature"]


class ExplicitSkip(ExcludedParent):
    def get_supported_openai_params(self, model):
        return super(ExcludedParent, self).get_supported_openai_params(model)


class BoundedRemoval(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        removed = ["tools", "functions"]
        for param in removed:
            if param in params:
                params.remove(param)
        return params


class MutableRemoval(Base):
    def get_supported_openai_params(self, model):
        params = super().get_supported_openai_params(model)
        removed = ["tools", "functions"]
        removed.append(model)
        for param in removed:
            if param in params:
                params.remove(param)
        return params


class ProofTest(unittest.TestCase):
    def test_additive_inherited_support_is_proven(self):
        evidence = {}
        self.assertIs(module.invariant_cache_key(Additive, evidence), True)
        self.assertEqual(len(evidence), 2)
        self.assertTrue(all(len(digest) == 64 for digest in evidence.values()))

    def test_bounded_filter_preserves_key(self):
        self.assertIs(module.invariant_cache_key(Filtering, {}), True)
        self.assertIsNone(module.invariant_cache_key(RemovingFilter, {}))

    def test_only_unrelated_removals_preserve_key(self):
        self.assertIs(module.invariant_cache_key(RemovingOther, {}), True)
        self.assertIs(module.invariant_cache_key(FilterReassignment, {}), True)
        self.assertIsNone(module.invariant_cache_key(UnsafeFilterReassignment, {}))

    def test_mutable_exclusion_is_not_a_literal_proof(self):
        self.assertIsNone(module.invariant_cache_key(MutatedExclusion, {}))

    def test_generated_model_predicate_survives_inherited_filters(self):
        expected = ["if", ["in", ["value", "search"], ["model"]], ["value", False], ["value", True]]
        self.assertEqual(module.class_program(PreserveBranch, {}), expected)

    def test_source_prefix_binding_retains_path_segment_boundary(self):
        program = module.compile_selector(route_prefix, {}, {"prefix": ["value", "openai/"]})
        self.assertEqual(program, ["or", ["starts", ["model"], ["value", "openai/"]], ["in", ["value", "/openai/"], ["model"]]])

    def test_explicit_super_uses_actual_receiver_mro(self):
        self.assertIs(module.invariant_cache_key(ExplicitSkip, {}), True)

    def test_bounded_loop_removal_preserves_key_but_mutable_exclusion_does_not(self):
        self.assertIs(module.invariant_cache_key(BoundedRemoval, {}), True)
        self.assertIsNone(module.invariant_cache_key(MutableRemoval, {}))

    def test_known_negative_is_proven(self):
        self.assertIs(module.invariant_cache_key(Negative, {}), False)

    def test_model_dependent_and_unrecognized_mutation_stay_unknown(self):
        for cls in (Conditional, Removing, Reassigning, Escaping):
            with self.subTest(cls=cls.__name__):
                self.assertIsNone(module.invariant_cache_key(cls, {}))


if __name__ == "__main__":
    unittest.main()
