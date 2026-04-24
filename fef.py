# -*- coding: utf-8 -*-
import os
import sys
import re
import json
import ast
import copy
import shutil
import tempfile
import subprocess
from pathlib import Path


TARGET_FILE = r"F:\public\cache\download\ai_git_folder\a.js"
RULES_FILE = r""

GPT_RULE = []

CONTEXT_RADIUS = 80
MAX_CONTEXTS = 3
OUTPUT_CONTEXT_MAX = 180

JS_REGEX_PREFIX_KEYWORDS = {
    "return",
    "throw",
    "case",
    "delete",
    "void",
    "typeof",
    "instanceof",
    "new",
    "do",
    "else",
    "yield",
    "await",
    "in",
    "of",
}


class PatchError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def read_text_utf8(path):
    with open(path, "r", encoding="utf-8", newline=None) as f:
        return f.read()


def write_text_atomic(path, text):
    path = str(path)
    directory = os.path.dirname(path) or "."
    fd, temp_path = tempfile.mkstemp(prefix=".patch_", suffix=".tmp", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(temp_path, path)
    except Exception:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass
        raise


def one_line(value, max_len=220):
    if value is None:
        return ""
    s = str(value).replace("\r", "").replace("\n", "\\n")
    if len(s) > max_len:
        return s[:max_len] + "...[truncated]"
    return s


def compact_context(text, start, token_len):
    lo = max(0, start - CONTEXT_RADIUS)
    hi = min(len(text), start + token_len + CONTEXT_RADIUS)
    snippet = text[lo:hi]
    snippet = snippet.replace("\r", "").replace("\n", "\\n")
    if len(snippet) > OUTPUT_CONTEXT_MAX:
        snippet = snippet[:OUTPUT_CONTEXT_MAX] + "...[truncated]"
    return snippet


def collect_contexts(text, pattern, positions, limit=MAX_CONTEXTS):
    if not pattern:
        return []
    contexts = []
    for pos in positions[:limit]:
        contexts.append(compact_context(text, pos, len(pattern)))
    return contexts


def extract_significant_tokens(pattern, limit=8):
    raw = []
    for line in str(pattern).replace("\r", "").split("\n"):
        part = line.strip()
        if not part:
            continue
        if len(part) >= 4:
            raw.append(part)
    raw.sort(key=len, reverse=True)
    result = []
    seen = set()
    for item in raw:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def collect_nearby_contexts(text, pattern, limit=MAX_CONTEXTS):
    tokens = extract_significant_tokens(pattern)
    contexts = []
    seen = set()
    for token in tokens:
        positions = find_all_non_overlapping(text, token)
        for pos in positions[:limit]:
            ctx = compact_context(text, pos, len(token))
            if ctx in seen:
                continue
            seen.add(ctx)
            contexts.append(ctx)
            if len(contexts) >= limit:
                return contexts
    return contexts


def strip_code_fences(text):
    s = text.strip()
    if not s:
        return s
    lines = s.splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
    return "\n".join(lines).strip()


def extract_first_list_literal(text):
    start = text.find("[")
    if start == -1:
        return None
    i = start
    depth = 0
    state = "code"
    quote = ""
    while i < len(text):
        ch = text[i]
        if state == "code":
            if ch in ("'", '"'):
                quote = ch
                state = "string"
                i += 1
                continue
            if ch == "[":
                depth += 1
                i += 1
                continue
            if ch == "]":
                depth -= 1
                i += 1
                if depth == 0:
                    return text[start:i]
                continue
            i += 1
            continue
        if state == "string":
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                state = "code"
                i += 1
                continue
            i += 1
            continue
    return None


def parse_rules_text(text):
    raw = strip_code_fences(text)
    if not raw:
        raise PatchError("RULES_PARSE_FAILED", "rules file is empty")

    candidates = [raw]

    if "GPT_RULE" in raw:
        idx = raw.find("GPT_RULE")
        eq = raw.find("=", idx)
        if eq != -1:
            rhs = raw[eq + 1:].strip()
            candidates.insert(0, rhs)
            lit = extract_first_list_literal(rhs)
            if lit:
                candidates.insert(0, lit)

    lit2 = extract_first_list_literal(raw)
    if lit2:
        candidates.insert(0, lit2)

    uniq = []
    seen = set()
    for item in candidates:
        key = item.strip()
        if key and key not in seen:
            seen.add(key)
            uniq.append(key)

    for candidate in uniq:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict) and "GPT_RULE" in value:
                value = value["GPT_RULE"]
            if isinstance(value, list):
                return value
        except Exception:
            pass
        try:
            value = ast.literal_eval(candidate)
            if isinstance(value, dict) and "GPT_RULE" in value:
                value = value["GPT_RULE"]
            if isinstance(value, list):
                return value
        except Exception:
            pass

    raise PatchError("RULES_PARSE_FAILED", "cannot parse rules file")


def load_rules():
    if RULES_FILE:
        return parse_rules_text(read_text_utf8(RULES_FILE))
    if isinstance(GPT_RULE, list) and GPT_RULE:
        return GPT_RULE
    raise PatchError("RULES_INVALID", "GPT_RULE must be a non-empty list")


def normalize_step(raw_step):
    step = copy.deepcopy(raw_step)
    if isinstance(step, dict):
        if "id" not in step and "step_id" in step:
            step["id"] = step["step_id"]
        step.setdefault("expect_change", True)
    return step


def ensure_dict(step, idx):
    if not isinstance(step, dict):
        raise PatchError("INVALID_STEP", f"step[{idx}] is not a dict", {"step_index": idx})


def ensure_step_required_fields(step, idx):
    if "id" not in step:
        raise PatchError("STEP_FIELD_MISSING", "step missing field: id", {"step_index": idx, "missing_field": "id"})
    if "language" not in step:
        raise PatchError("STEP_FIELD_MISSING", "step missing field: language", {"step_index": idx, "missing_field": "language"})
    if "mode" not in step:
        raise PatchError("STEP_FIELD_MISSING", "step missing field: mode", {"step_index": idx, "missing_field": "mode"})


def ensure_unique_step_ids(rules):
    seen = {}
    for idx, step in enumerate(rules):
        sid = step.get("id")
        if sid in seen:
            raise PatchError(
                "DUPLICATE_STEP_ID",
                "duplicate step id",
                {
                    "step_index": idx,
                    "step_id": sid,
                    "first_index": seen[sid],
                },
            )
        seen[sid] = idx


def ensure_rule_dict(step):
    if "rule" not in step:
        raise PatchError("RULE_FIELD_MISSING", "rule field missing", {"step_id": step.get("id")})
    rule = step.get("rule")
    if not isinstance(rule, dict):
        raise PatchError("RULE_NOT_DICT", "rule must be a dict", {"step_id": step.get("id")})
    return rule


def require_string_field(rule, field_name, missing_code, step_id):
    if field_name not in rule:
        raise PatchError(missing_code, f"{field_name} missing", {"step_id": step_id})
    value = rule.get(field_name)
    if not isinstance(value, str):
        if field_name == "pattern":
            raise PatchError("RULE_PATTERN_NOT_STRING", "pattern must be a string", {"step_id": step_id})
        raise PatchError("RULE_FIELD_NOT_STRING", f"{field_name} must be a string", {"step_id": step_id, "field": field_name})
    if value == "":
        if field_name == "pattern":
            raise PatchError("RULE_PATTERN_EMPTY", "pattern is empty", {"step_id": step_id})
        raise PatchError(missing_code, f"{field_name} is empty", {"step_id": step_id, "field": field_name})
    return value


def validate_text_unique_structure(step):
    step_id = step.get("id")
    variant = step.get("variant")
    if not variant:
        raise PatchError("STEP_FIELD_MISSING", "variant missing", {"step_id": step_id, "missing_field": "variant"})

    for key in ("pattern", "scope_pattern", "before", "after", "occurrence", "occurrences"):
        if key in step:
            raise PatchError(
                "STRUCTURE_FIELD_AT_TOPLEVEL",
                f"{key} must be inside rule",
                {"step_id": step_id, "field": key},
            )

    rule = ensure_rule_dict(step)

    if variant in ("exact_unique", "block_unique"):
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)

    elif variant in ("scoped_unique", "block_in_scope"):
        require_string_field(rule, "scope_pattern", "RULE_SCOPE_PATTERN_MISSING", step_id)
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)

    elif variant == "anchored_unique":
        require_string_field(rule, "before", "RULE_BEFORE_MISSING", step_id)
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)
        require_string_field(rule, "after", "RULE_AFTER_MISSING", step_id)

    elif variant == "anchored_in_scope":
        require_string_field(rule, "scope_pattern", "RULE_SCOPE_PATTERN_MISSING", step_id)
        require_string_field(rule, "before", "RULE_BEFORE_MISSING", step_id)
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)
        require_string_field(rule, "after", "RULE_AFTER_MISSING", step_id)

    elif variant == "occurrence_in_scope":
        require_string_field(rule, "scope_pattern", "RULE_SCOPE_PATTERN_MISSING", step_id)
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)
        if "occurrence" not in rule:
            raise PatchError("RULE_OCCURRENCE_MISSING", "occurrence missing", {"step_id": step_id})
        if not isinstance(rule.get("occurrence"), int) or rule.get("occurrence") < 1:
            raise PatchError("OCCURRENCE_INVALID", "occurrence must be >= 1", {"step_id": step_id})
        if step.get("expected_match_count") is None:
            raise PatchError("EXPECTED_MATCH_COUNT_REQUIRED", "expected_match_count required", {"step_id": step_id})

    elif variant == "batch_occurrence_in_scope":
        require_string_field(rule, "scope_pattern", "RULE_SCOPE_PATTERN_MISSING", step_id)
        require_string_field(rule, "pattern", "RULE_PATTERN_MISSING", step_id)
        if "occurrences" not in rule:
            raise PatchError("RULE_OCCURRENCES_MISSING", "occurrences missing", {"step_id": step_id})
        occurrences = rule.get("occurrences")
        if not isinstance(occurrences, list) or not occurrences:
            raise PatchError("RULE_OCCURRENCES_MISSING", "occurrences must be a non-empty list", {"step_id": step_id})
        if step.get("expected_match_count") is None:
            raise PatchError("EXPECTED_MATCH_COUNT_REQUIRED", "expected_match_count required", {"step_id": step_id})

    else:
        raise PatchError("UNKNOWN_VARIANT", "unknown text_unique variant", {"step_id": step_id, "variant": variant})


def validate_ast_structure(step):
    rule = ensure_rule_dict(step)
    if not isinstance(rule, dict):
        raise PatchError("AST_RULE_INVALID", "ast rule must be a dict", {"step_id": step.get("id")})


def validate_step_structure(step):
    mode = step.get("mode")
    if mode == "text_unique":
        validate_text_unique_structure(step)
        return
    if mode == "ast":
        validate_ast_structure(step)
        return
    raise PatchError("UNKNOWN_MODE", "unknown mode", {"step_id": step.get("id"), "mode": mode})


def ensure_language_consistent(rules):
    languages = []
    for step in rules:
        lang = step.get("language")
        if lang is not None:
            languages.append(lang)
    uniq = sorted(set(languages))
    if len(uniq) > 1:
        raise PatchError("LANGUAGE_MISMATCH", "multiple languages in one batch", {"languages": uniq})


def normalize_rules(raw_rules):
    if not isinstance(raw_rules, list) or not raw_rules:
        raise PatchError("RULES_INVALID", "GPT_RULE must be a non-empty list")
    normalized = []
    for idx, raw_step in enumerate(raw_rules):
        ensure_dict(raw_step, idx)
        step = normalize_step(raw_step)
        ensure_step_required_fields(step, idx)
        validate_step_structure(step)
        normalized.append(step)
    ensure_unique_step_ids(normalized)
    ensure_language_consistent(normalized)
    return normalized


def find_all_non_overlapping(text, pattern):
    if pattern is None or pattern == "":
        return []
    result = []
    start = 0
    plen = len(pattern)
    while True:
        idx = text.find(pattern, start)
        if idx == -1:
            break
        result.append(idx)
        start = idx + plen
    return result


def replace_once_at(text, start, old, new):
    if start < 0 or start + len(old) > len(text):
        raise PatchError("REPLACE_RANGE_INVALID", "replace range invalid", {"start": start})
    if text[start:start + len(old)] != old:
        raise PatchError(
            "REPLACE_SOURCE_MISMATCH",
            "source mismatch at replace position",
            {
                "start": start,
                "pattern": old,
                "actual_slice": text[start:start + len(old)],
            },
        )
    return text[:start] + new + text[start + len(old):]


def detect_ast_command():
    for cmd in ("ast-grep", "sg"):
        found = shutil.which(cmd)
        if found:
            return found
    return None


def run_cmd(cmd, cwd=None):
    return subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def find_matching_brace(text, open_brace_index):
    if open_brace_index < 0 or open_brace_index >= len(text):
        raise PatchError("BRACE_OPEN_INDEX_INVALID", "invalid open brace index", {"open_brace_index": open_brace_index})
    if text[open_brace_index] != "{":
        raise PatchError("BRACE_OPEN_NOT_FOUND", "target char is not '{'", {"open_brace_index": open_brace_index})

    depth = 0
    i = open_brace_index
    stack = [{"type": "code"}]

    while i < len(text):
        state = stack[-1]
        stype = state["type"]
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if stype == "code":
            if ch == "'":
                stack.append({"type": "single"})
                i += 1
                continue
            if ch == '"':
                stack.append({"type": "double"})
                i += 1
                continue
            if ch == "`":
                stack.append({"type": "template"})
                i += 1
                continue
            if ch == "/" and nxt == "/":
                stack.append({"type": "line_comment"})
                i += 2
                continue
            if ch == "/" and nxt == "*":
                stack.append({"type": "block_comment"})
                i += 2
                continue
            if ch == "{":
                depth += 1
                i += 1
                continue
            if ch == "}":
                depth -= 1
                i += 1
                if depth == 0:
                    return i
                continue
            i += 1
            continue

        if stype == "single":
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                stack.pop()
                i += 1
                continue
            i += 1
            continue

        if stype == "double":
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                stack.pop()
                i += 1
                continue
            i += 1
            continue

        if stype == "line_comment":
            if ch == "\n":
                stack.pop()
            i += 1
            continue

        if stype == "block_comment":
            if ch == "*" and nxt == "/":
                stack.pop()
                i += 2
                continue
            i += 1
            continue

        if stype == "template":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                stack.pop()
                i += 1
                continue
            if ch == "$" and nxt == "{":
                depth += 1
                stack.append({"type": "template_expr", "depth": 1})
                i += 2
                continue
            i += 1
            continue

        if stype == "template_expr":
            if ch == "'":
                stack.append({"type": "single"})
                i += 1
                continue
            if ch == '"':
                stack.append({"type": "double"})
                i += 1
                continue
            if ch == "`":
                stack.append({"type": "template"})
                i += 1
                continue
            if ch == "/" and nxt == "/":
                stack.append({"type": "line_comment"})
                i += 2
                continue
            if ch == "/" and nxt == "*":
                stack.append({"type": "block_comment"})
                i += 2
                continue
            if ch == "{":
                depth += 1
                state["depth"] += 1
                i += 1
                continue
            if ch == "}":
                depth -= 1
                state["depth"] -= 1
                i += 1
                if depth == 0:
                    return i
                if state["depth"] == 0:
                    stack.pop()
                continue
            i += 1
            continue

    raise PatchError("UNTERMINATED_SCOPE", "cannot find scope closing brace", {"open_brace_index": open_brace_index})


def extract_scope(text, scope_pattern):
    if not scope_pattern:
        raise PatchError("SCOPE_PATTERN_EMPTY", "scope_pattern is empty")

    scope_positions = find_all_non_overlapping(text, scope_pattern)
    if len(scope_positions) != 1:
        raise PatchError(
            "SCOPE_MATCH_COUNT_MISMATCH",
            "scope_pattern match count mismatch",
            {
                "scope_pattern": scope_pattern,
                "actual_match_count": len(scope_positions),
                "expected_match_count": 1,
                "contexts": collect_contexts(text, scope_pattern, scope_positions) or collect_nearby_contexts(text, scope_pattern),
            },
        )

    scope_start = scope_positions[0]
    rel_open = scope_pattern.rfind("{")
    if rel_open != -1:
        open_brace_index = scope_start + rel_open
    else:
        next_open = text.find("{", scope_start + len(scope_pattern))
        if next_open == -1:
            raise PatchError("SCOPE_BRACE_NOT_FOUND", "cannot find '{' after scope_pattern", {"scope_pattern": scope_pattern})
        open_brace_index = next_open

    scope_end = find_matching_brace(text, open_brace_index)
    scope_text = text[scope_start:scope_end]
    return scope_start, scope_end, scope_text


def build_match_count_error(step_id, pattern, actual, expected, text_for_context, positions=None, scope_pattern=None, occurrence=None, before=None, after=None):
    positions = positions or []
    token = before + pattern + after if before is not None and after is not None else pattern
    contexts = collect_contexts(text_for_context, token, positions)
    if not contexts and actual == 0:
        contexts = collect_nearby_contexts(text_for_context, pattern)
    details = {
        "step_id": step_id,
        "pattern": pattern,
        "actual_match_count": actual,
        "expected_match_count": expected,
    }
    if contexts:
        details["contexts"] = contexts
    if scope_pattern is not None:
        details["scope_pattern"] = scope_pattern
    if occurrence is not None:
        details["occurrence"] = occurrence
    if before is not None:
        details["before"] = before
    if after is not None:
        details["after"] = after
    return PatchError("MATCH_COUNT_MISMATCH", "match count mismatch", details)


def js_can_start_regex(last_token_type):
    if last_token_type in (None, "start", "operator", "open_paren", "open_bracket", "open_brace", "comma", "colon", "semicolon"):
        return True
    if isinstance(last_token_type, str) and last_token_type.startswith("keyword:"):
        word = last_token_type.split(":", 1)[1]
        if word in JS_REGEX_PREFIX_KEYWORDS:
            return True
    return False


def validate_js_text_integrity(text):
    stack = [{"type": "code"}]
    brace_count = 0
    bracket_count = 0
    paren_count = 0
    i = 0
    last_token_type = "start"

    while i < len(text):
        state = stack[-1]
        stype = state["type"]
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if stype in ("code", "template_expr"):
            if ch.isspace():
                i += 1
                continue

            if ch.isalpha() or ch in ("_", "$"):
                j = i + 1
                while j < len(text) and (text[j].isalnum() or text[j] in ("_", "$")):
                    j += 1
                word = text[i:j]
                if word in JS_REGEX_PREFIX_KEYWORDS:
                    last_token_type = f"keyword:{word}"
                else:
                    last_token_type = "identifier"
                i = j
                continue

            if ch.isdigit():
                j = i + 1
                while j < len(text) and (text[j].isalnum() or text[j] in (".", "_")):
                    j += 1
                last_token_type = "number"
                i = j
                continue

            if ch == "'":
                stack.append({"type": "single"})
                i += 1
                continue

            if ch == '"':
                stack.append({"type": "double"})
                i += 1
                continue

            if ch == "`":
                stack.append({"type": "template"})
                i += 1
                continue

            if ch == "/" and nxt == "/":
                stack.append({"type": "line_comment"})
                i += 2
                continue

            if ch == "/" and nxt == "*":
                stack.append({"type": "block_comment"})
                i += 2
                continue

            if ch == "/":
                if js_can_start_regex(last_token_type):
                    stack.append({"type": "regex"})
                    i += 1
                    continue
                last_token_type = "operator"
                i += 1
                continue

            if ch == "{":
                brace_count += 1
                if stype == "template_expr":
                    state["depth"] += 1
                last_token_type = "open_brace"
                i += 1
                continue

            if ch == "}":
                brace_count -= 1
                if brace_count < 0:
                    raise PatchError("UNBALANCED_BRACES", "unbalanced braces", {})
                if stype == "template_expr":
                    state["depth"] -= 1
                    i += 1
                    if state["depth"] == 0:
                        stack.pop()
                        last_token_type = "close_brace"
                        continue
                    last_token_type = "close_brace"
                    continue
                last_token_type = "close_brace"
                i += 1
                continue

            if ch == "[":
                bracket_count += 1
                last_token_type = "open_bracket"
                i += 1
                continue

            if ch == "]":
                bracket_count -= 1
                if bracket_count < 0:
                    raise PatchError("UNBALANCED_BRACKETS", "unbalanced brackets", {})
                last_token_type = "close_bracket"
                i += 1
                continue

            if ch == "(":
                paren_count += 1
                last_token_type = "open_paren"
                i += 1
                continue

            if ch == ")":
                paren_count -= 1
                if paren_count < 0:
                    raise PatchError("UNBALANCED_PARENTHESES", "unbalanced parentheses", {})
                last_token_type = "close_paren"
                i += 1
                continue

            if ch == ",":
                last_token_type = "comma"
                i += 1
                continue

            if ch == ":":
                last_token_type = "colon"
                i += 1
                continue

            if ch == ";":
                last_token_type = "semicolon"
                i += 1
                continue

            last_token_type = "operator"
            i += 1
            continue

        if stype == "single":
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                stack.pop()
                last_token_type = "string"
                i += 1
                continue
            i += 1
            continue

        if stype == "double":
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                stack.pop()
                last_token_type = "string"
                i += 1
                continue
            i += 1
            continue

        if stype == "line_comment":
            if ch == "\n":
                stack.pop()
            i += 1
            continue

        if stype == "block_comment":
            if ch == "*" and nxt == "/":
                stack.pop()
                i += 2
                continue
            i += 1
            continue

        if stype == "template":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                stack.pop()
                last_token_type = "string"
                i += 1
                continue
            if ch == "$" and nxt == "{":
                brace_count += 1
                stack.append({"type": "template_expr", "depth": 1})
                i += 2
                continue
            i += 1
            continue

        if stype == "regex":
            if ch == "\\":
                i += 2
                continue
            if ch == "[":
                stack.append({"type": "regex_char_class"})
                i += 1
                continue
            if ch == "/":
                stack.pop()
                i += 1
                while i < len(text) and (text[i].isalpha() or text[i].isdigit()):
                    i += 1
                last_token_type = "regex"
                continue
            i += 1
            continue

        if stype == "regex_char_class":
            if ch == "\\":
                i += 2
                continue
            if ch == "]":
                stack.pop()
                i += 1
                continue
            i += 1
            continue

    if len(stack) > 1:
        t = stack[-1]["type"]
        if t == "block_comment":
            raise PatchError("UNTERMINATED_BLOCK_COMMENT", "unterminated block comment", {})
        if t == "single":
            raise PatchError("UNTERMINATED_SINGLE_QUOTE", "unterminated single quoted string", {})
        if t == "double":
            raise PatchError("UNTERMINATED_DOUBLE_QUOTE", "unterminated double quoted string", {})
        if t == "template":
            raise PatchError("UNTERMINATED_TEMPLATE_STRING", "unterminated template string", {})
        if t == "template_expr":
            raise PatchError("UNTERMINATED_TEMPLATE_EXPRESSION", "unterminated template expression", {})
        if t == "regex":
            raise PatchError("UNTERMINATED_REGEX_LITERAL", "unterminated regex literal", {})
        if t == "regex_char_class":
            raise PatchError("UNTERMINATED_REGEX_CHAR_CLASS", "unterminated regex char class", {})

    if brace_count != 0:
        raise PatchError("UNBALANCED_BRACES", "unbalanced braces", {"brace_count": brace_count})
    if bracket_count != 0:
        raise PatchError("UNBALANCED_BRACKETS", "unbalanced brackets", {"bracket_count": bracket_count})
    if paren_count != 0:
        raise PatchError("UNBALANCED_PARENTHESES", "unbalanced parentheses", {"paren_count": paren_count})


def validate_python_text_integrity(text):
    try:
        compile(text, "<patched_python>", "exec")
    except SyntaxError as e:
        raise PatchError(
            "PYTHON_SYNTAX_ERROR",
            "python syntax error after patch",
            {
                "lineno": getattr(e, "lineno", None),
                "offset": getattr(e, "offset", None),
                "text": getattr(e, "text", None),
                "msg": getattr(e, "msg", None),
            },
        )


def validate_intermediate_text(text, language, original=False):
    lang = (language or "").strip().lower()
    if lang == "python":
        validate_python_text_integrity(text)
        return
    if lang in ("javascript", "js", "typescript", "ts", "jsx", "tsx"):
        if original:
            return
        validate_js_text_integrity(text)
        return


def apply_exact_unique(text, step):
    rule = step.get("rule", {})
    pattern = rule.get("pattern")
    fix = step.get("fix", "")
    positions = find_all_non_overlapping(text, pattern)
    if len(positions) != 1:
        raise build_match_count_error(step["id"], pattern, len(positions), 1, text, positions=positions)
    new_text = replace_once_at(text, positions[0], pattern, fix)
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern})
    return new_text


def apply_block_unique(text, step):
    return apply_exact_unique(text, step)


def apply_scoped_unique(text, step):
    rule = step.get("rule", {})
    scope_pattern = rule.get("scope_pattern")
    pattern = rule.get("pattern")
    fix = step.get("fix", "")

    scope_start, scope_end, scope_text = extract_scope(text, scope_pattern)
    positions = find_all_non_overlapping(scope_text, pattern)
    if len(positions) != 1:
        raise build_match_count_error(step["id"], pattern, len(positions), 1, scope_text, positions=positions, scope_pattern=scope_pattern)

    new_scope_text = replace_once_at(scope_text, positions[0], pattern, fix)
    new_text = text[:scope_start] + new_scope_text + text[scope_end:]
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern, "scope_pattern": scope_pattern})
    return new_text


def apply_block_in_scope(text, step):
    return apply_scoped_unique(text, step)


def apply_anchored_unique(text, step):
    rule = step.get("rule", {})
    before = rule.get("before")
    pattern = rule.get("pattern")
    after = rule.get("after")
    fix = step.get("fix", "")
    combo = before + pattern + after
    positions = find_all_non_overlapping(text, combo)
    if len(positions) != 1:
        raise build_match_count_error(step["id"], pattern, len(positions), 1, text, positions=positions, before=before, after=after)

    new_text = replace_once_at(text, positions[0], combo, before + fix + after)
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern, "before": before, "after": after})
    return new_text


def apply_anchored_in_scope(text, step):
    rule = step.get("rule", {})
    scope_pattern = rule.get("scope_pattern")
    before = rule.get("before")
    pattern = rule.get("pattern")
    after = rule.get("after")
    fix = step.get("fix", "")
    scope_start, scope_end, scope_text = extract_scope(text, scope_pattern)
    combo = before + pattern + after
    positions = find_all_non_overlapping(scope_text, combo)
    if len(positions) != 1:
        raise build_match_count_error(
            step["id"],
            pattern,
            len(positions),
            1,
            scope_text,
            positions=positions,
            scope_pattern=scope_pattern,
            before=before,
            after=after,
        )

    new_scope_text = replace_once_at(scope_text, positions[0], combo, before + fix + after)
    new_text = text[:scope_start] + new_scope_text + text[scope_end:]
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern, "scope_pattern": scope_pattern, "before": before, "after": after})
    return new_text


def apply_occurrence_in_scope(text, step):
    rule = step.get("rule", {})
    scope_pattern = rule.get("scope_pattern")
    pattern = rule.get("pattern")
    occurrence = rule.get("occurrence")
    expected_match_count = step.get("expected_match_count")
    fix = step.get("fix", "")

    scope_start, scope_end, scope_text = extract_scope(text, scope_pattern)
    positions = find_all_non_overlapping(scope_text, pattern)
    if len(positions) != expected_match_count:
        raise build_match_count_error(
            step["id"],
            pattern,
            len(positions),
            expected_match_count,
            scope_text,
            positions=positions,
            scope_pattern=scope_pattern,
            occurrence=occurrence,
        )

    if occurrence > len(positions):
        raise PatchError(
            "OCCURRENCE_NOT_FOUND",
            "occurrence out of range",
            {
                "pattern": pattern,
                "scope_pattern": scope_pattern,
                "occurrence": occurrence,
                "actual_match_count": len(positions),
                "contexts": collect_contexts(scope_text, pattern, positions) or collect_nearby_contexts(scope_text, pattern),
            },
        )

    target_pos = positions[occurrence - 1]
    new_scope_text = replace_once_at(scope_text, target_pos, pattern, fix)
    new_text = text[:scope_start] + new_scope_text + text[scope_end:]
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern, "scope_pattern": scope_pattern})
    return new_text


def apply_batch_occurrence_in_scope(text, step):
    rule = step.get("rule", {})
    scope_pattern = rule.get("scope_pattern")
    pattern = rule.get("pattern")
    occurrences = rule.get("occurrences")
    expected_match_count = step.get("expected_match_count")

    normalized = []
    seen_occ = set()
    for item in occurrences:
        if not isinstance(item, dict):
            raise PatchError("OCCURRENCES_ITEM_INVALID", "occurrence item must be a dict", {"item": item})
        occ = item.get("occurrence")
        fix = item.get("fix")
        if not isinstance(occ, int) or occ < 1:
            raise PatchError("OCCURRENCE_INVALID", "occurrence must be >= 1", {"item": item})
        if occ in seen_occ:
            raise PatchError("DUPLICATE_OCCURRENCE", "duplicate occurrence", {"occurrence": occ})
        if fix is None:
            raise PatchError("FIX_MISSING", "fix missing in occurrence item", {"occurrence": occ})
        if pattern in fix:
            raise PatchError("FIX_REINTRODUCES_PATTERN", "fix reintroduces original pattern", {"pattern": pattern, "occurrence": occ})
        seen_occ.add(occ)
        normalized.append({"occurrence": occ, "fix": fix})

    scope_start, scope_end, scope_text = extract_scope(text, scope_pattern)
    positions = find_all_non_overlapping(scope_text, pattern)
    if len(positions) != expected_match_count:
        raise build_match_count_error(
            step["id"],
            pattern,
            len(positions),
            expected_match_count,
            scope_text,
            positions=positions,
            scope_pattern=scope_pattern,
        )

    for item in normalized:
        if item["occurrence"] > len(positions):
            raise PatchError(
                "OCCURRENCE_NOT_FOUND",
                "occurrence out of range",
                {
                    "pattern": pattern,
                    "scope_pattern": scope_pattern,
                    "occurrence": item["occurrence"],
                    "actual_match_count": len(positions),
                    "contexts": collect_contexts(scope_text, pattern, positions) or collect_nearby_contexts(scope_text, pattern),
                },
            )

    new_scope_text = scope_text
    for item in sorted(normalized, key=lambda x: x["occurrence"], reverse=True):
        target_pos = positions[item["occurrence"] - 1]
        new_scope_text = replace_once_at(new_scope_text, target_pos, pattern, item["fix"])

    new_text = text[:scope_start] + new_scope_text + text[scope_end:]
    if step.get("expect_change", True) and new_text == text:
        raise PatchError("NO_CHANGE", "no change produced", {"pattern": pattern, "scope_pattern": scope_pattern})
    return new_text


def language_to_extension(language):
    lang = (language or "").strip().lower()
    mapping = {
        "javascript": ".js",
        "js": ".js",
        "typescript": ".ts",
        "ts": ".ts",
        "jsx": ".jsx",
        "tsx": ".tsx",
        "python": ".py",
        "json": ".json",
        "html": ".html",
        "css": ".css",
    }
    return mapping.get(lang, ".txt")


def apply_ast_mode(text, step):
    ast_cmd = detect_ast_command()
    if not ast_cmd:
        raise PatchError("AST_TOOL_UNAVAILABLE", "ast tool unavailable", {"step_id": step["id"]})

    language = step.get("language")
    rule = step.get("rule")
    fix = step.get("fix")
    expected_match_count = step.get("expected_match_count")

    config = {"language": language, "rule": rule}
    if "fix" in step:
        config["fix"] = fix

    with tempfile.TemporaryDirectory(prefix="patch_ast_") as td:
        ext = language_to_extension(language)
        temp_target = os.path.join(td, "temp_target" + ext)
        temp_rule = os.path.join(td, "rule.json")
        with open(temp_target, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        with open(temp_rule, "w", encoding="utf-8", newline="\n") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        count_cmd = [ast_cmd, "scan", "-r", temp_rule, temp_target, "--json=stream"]
        count_res = run_cmd(count_cmd)
        if count_res.returncode != 0:
            raise PatchError("AST_SCAN_FAILED", "ast scan failed", {"stderr": count_res.stderr})

        lines = [line for line in count_res.stdout.splitlines() if line.strip()]
        match_count = len(lines)

        if expected_match_count is not None and match_count != expected_match_count:
            raise PatchError(
                "MATCH_COUNT_MISMATCH",
                "match count mismatch",
                {
                    "actual_match_count": match_count,
                    "expected_match_count": expected_match_count,
                    "pattern": rule.get("pattern"),
                },
            )

        update_cmd = [ast_cmd, "scan", "-r", temp_rule, "-U", temp_target]
        update_res = run_cmd(update_cmd)
        if update_res.returncode != 0:
            raise PatchError("AST_EXEC_FAILED", "ast exec failed", {"stderr": update_res.stderr})

        new_text = read_text_utf8(temp_target)
        if step.get("expect_change", True) and new_text == text:
            raise PatchError("NO_CHANGE", "no change produced", {"pattern": rule.get("pattern")})
        return new_text


def apply_step(text, step):
    mode = step["mode"]
    if mode == "text_unique":
        variant = step.get("variant")
        if variant == "exact_unique":
            return apply_exact_unique(text, step)
        if variant == "scoped_unique":
            return apply_scoped_unique(text, step)
        if variant == "anchored_unique":
            return apply_anchored_unique(text, step)
        if variant == "anchored_in_scope":
            return apply_anchored_in_scope(text, step)
        if variant == "occurrence_in_scope":
            return apply_occurrence_in_scope(text, step)
        if variant == "batch_occurrence_in_scope":
            return apply_batch_occurrence_in_scope(text, step)
        if variant == "block_unique":
            return apply_block_unique(text, step)
        if variant == "block_in_scope":
            return apply_block_in_scope(text, step)
        raise PatchError("UNKNOWN_VARIANT", "unknown text_unique variant", {"variant": variant})

    if mode == "ast":
        return apply_ast_mode(text, step)

    raise PatchError("UNKNOWN_MODE", "unknown mode", {"mode": mode})


def run_stage(initial_text, rules, stage_name):
    current_text = initial_text
    for idx, step in enumerate(rules):
        try:
            current_text = apply_step(current_text, step)
            validate_intermediate_text(current_text, step.get("language"), original=False)
        except PatchError as e:
            return {
                "ok": False,
                "stage": stage_name,
                "step_index": idx,
                "step": step,
                "error": e,
            }

    return {
        "ok": True,
        "stage": stage_name,
        "steps": len(rules),
        "final_text": current_text,
    }


def execute_patch(target_file, raw_rules):
    target_file = str(Path(target_file))
    if not target_file:
        raise PatchError("TARGET_FILE_EMPTY", "target file is empty")
    if not os.path.isfile(target_file):
        raise PatchError("TARGET_FILE_NOT_FOUND", "target file not found", {"target_file": target_file})

    rules = normalize_rules(raw_rules)
    original_text = read_text_utf8(target_file)
    validate_intermediate_text(original_text, rules[0].get("language"), original=True)

    preview = run_stage(original_text, rules, "preview")
    if not preview["ok"]:
        return preview

    formal = run_stage(original_text, rules, "formal")
    if not formal["ok"]:
        return formal

    if preview["final_text"] != formal["final_text"]:
        return {
            "ok": False,
            "stage": "consistency_check",
            "step_index": None,
            "step": None,
            "error": PatchError("PREVIEW_FORMAL_MISMATCH", "preview/formal mismatch"),
        }

    try:
        write_text_atomic(target_file, formal["final_text"])
        return {
            "ok": True,
            "stage": "done",
            "steps": len(rules),
        }
    except Exception as e:
        return {
            "ok": False,
            "stage": "write_back",
            "step_index": None,
            "step": None,
            "error": PatchError("WRITE_FAILED", "write failed", {"exception": repr(e)}),
        }


def build_hint(result):
    error = result["error"]
    details = error.details if isinstance(error, PatchError) else {}
    step = result.get("step") or {}
    variant = step.get("variant")
    stage = result.get("stage")
    code = error.code

    if code == "RULES_PARSE_FAILED":
        return "rules_file_must_be_json_list_or_gpt_rule_assignment"
    if code == "STEP_FIELD_MISSING":
        return "step_requires_id_language_mode"
    if code == "STRUCTURE_FIELD_AT_TOPLEVEL":
        return "move_locator_fields_into_rule_object"
    if code == "RULE_FIELD_MISSING":
        return "step_requires_rule_object"
    if code == "RULE_NOT_DICT":
        return "rule_must_be_dict"
    if code in ("RULE_PATTERN_MISSING", "RULE_PATTERN_EMPTY", "RULE_PATTERN_NOT_STRING"):
        return "pattern_must_exist_and_be_non_empty_string"
    if code == "RULE_SCOPE_PATTERN_MISSING":
        return "scope_pattern_required_for_scope_variants"
    if code in ("RULE_BEFORE_MISSING", "RULE_AFTER_MISSING"):
        return "before_after_required_for_anchor_variants"
    if code == "RULE_OCCURRENCE_MISSING":
        return "occurrence_required_for_occurrence_in_scope"
    if code == "RULE_OCCURRENCES_MISSING":
        return "occurrences_required_for_batch_occurrence_in_scope"
    if code == "DUPLICATE_STEP_ID":
        return "step_id_must_be_unique"
    if code == "LANGUAGE_MISMATCH":
        return "all_steps_in_same_batch_must_use_same_language"
    if code == "SCOPE_MATCH_COUNT_MISMATCH":
        return "scope_not_unique_or_baseline_mismatch"
    if code == "MATCH_COUNT_MISMATCH":
        if variant in ("exact_unique", "block_unique"):
            return "pattern_not_unique_or_missing_use_scope_or_longer_block"
        if variant in ("scoped_unique", "block_in_scope"):
            return "pattern_not_unique_in_scope_use_longer_block_or_anchor"
        if variant == "anchored_unique":
            return "anchor_not_unique_refine_before_after"
        if variant == "anchored_in_scope":
            return "anchor_not_unique_in_scope_refine_before_after"
        if variant in ("occurrence_in_scope", "batch_occurrence_in_scope"):
            return "count_changed_or_pattern_unstable_use_anchor_or_split_batch"
        return "match_count_mismatch_refine_pattern"
    if code == "OCCURRENCE_NOT_FOUND":
        return "occurrence_out_of_range_or_previous_steps_changed_count"
    if code == "NO_CHANGE":
        return "target_already_modified_or_fix_has_no_effect"
    if code == "REPLACE_SOURCE_MISMATCH":
        return "baseline_changed_or_previous_steps_changed_text"
    if code == "FIX_REINTRODUCES_PATTERN":
        return "batch_fix_reintroduces_pattern"
    if code == "AST_TOOL_UNAVAILABLE":
        return "ast_not_available_use_text_unique"
    if code in (
        "UNTERMINATED_BLOCK_COMMENT",
        "UNTERMINATED_SINGLE_QUOTE",
        "UNTERMINATED_DOUBLE_QUOTE",
        "UNTERMINATED_TEMPLATE_STRING",
        "UNTERMINATED_TEMPLATE_EXPRESSION",
        "UNTERMINATED_REGEX_LITERAL",
        "UNTERMINATED_REGEX_CHAR_CLASS",
        "UNBALANCED_BRACES",
        "UNBALANCED_BRACKETS",
        "UNBALANCED_PARENTHESES",
        "PYTHON_SYNTAX_ERROR",
    ):
        if stage == "setup":
            return "original_text_integrity_check_failed"
        return "intermediate_text_broken_split_batch_or_use_single_block_replace"
    if code == "UNKNOWN_VARIANT":
        return "variant_not_supported_by_patcher"
    return "refine_rule_or_split_batch"


def print_result(result):
    if result["ok"]:
        print("ok=true")
        print("stage=done")
        print(f"steps={result.get('steps', 0)}")
        print("true")
        return

    error = result["error"]
    details = error.details if isinstance(error, PatchError) else {}
    step = result.get("step") or {}
    rule = step.get("rule", {}) if isinstance(step, dict) else {}

    print("ok=false")
    print(f"stage={result.get('stage', '')}")

    if result.get("step_index") is not None:
        print(f"step_index={result['step_index']}")
    if step.get("id") is not None:
        print(f"step_id={one_line(step.get('id'))}")
    if step.get("mode") is not None:
        print(f"mode={one_line(step.get('mode'))}")
    if step.get("variant") is not None:
        print(f"variant={one_line(step.get('variant'))}")

    print(f"code={one_line(error.code)}")
    print(f"message={one_line(error.message)}")

    expected = details.get("expected_match_count")
    actual = details.get("actual_match_count")
    occurrence = details.get("occurrence")

    if expected is not None:
        print(f"expected={expected}")
    if actual is not None:
        print(f"actual={actual}")
    if occurrence is not None:
        print(f"occurrence={occurrence}")

    scope_pattern = details.get("scope_pattern") or rule.get("scope_pattern")
    pattern = details.get("pattern") or rule.get("pattern")
    before = details.get("before") or rule.get("before")
    after = details.get("after") or rule.get("after")

    if scope_pattern:
        print(f"scope_pattern={one_line(scope_pattern)}")
    if pattern:
        print(f"pattern={one_line(pattern)}")
    if before:
        print(f"before={one_line(before)}")
    if after:
        print(f"after={one_line(after)}")

    contexts = details.get("contexts") or []
    for idx, ctx in enumerate(contexts[:MAX_CONTEXTS], start=1):
        print(f"context_{idx}={one_line(ctx, max_len=OUTPUT_CONTEXT_MAX + 20)}")

    for key in ("lineno", "offset", "text", "msg"):
        if key in details and details[key] is not None:
            print(f"{key}={one_line(details[key])}")

    print(f"hint={build_hint(result)}")
    print("false")


def main():
    target_file = TARGET_FILE
    if len(sys.argv) >= 2:
        target_file = sys.argv[1]

    try:
        raw_rules = load_rules()
        result = execute_patch(target_file, raw_rules)
    except PatchError as e:
        result = {
            "ok": False,
            "stage": "setup",
            "step_index": None,
            "step": None,
            "error": e,
        }
    except Exception as e:
        result = {
            "ok": False,
            "stage": "setup",
            "step_index": None,
            "step": None,
            "error": PatchError("UNEXPECTED_ERROR", "unexpected error", {"exception": repr(e)}),
        }

    print_result(result)
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
