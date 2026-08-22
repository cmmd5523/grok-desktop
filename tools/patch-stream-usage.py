# -*- coding: utf-8 -*-
"""Patch grok2api chat.py: emit a usage chunk at the end of streaming responses."""
import io
import shutil
import ast
import sys

F = "/opt/grok2api/grok2api/app/products/openai/chat.py"
shutil.copy(F, F + ".bak-usage")

src = io.open(F, encoding="utf-8").read()

old = '''                            yield f"data: {orjson.dumps(final).decode()}\\n\\n"
                            yield "data: [DONE]\\n\\n"'''

new = '''                            yield f"data: {orjson.dumps(final).decode()}\\n\\n"
                            # Streaming usage chunk (OpenAI standard: empty choices + usage).
                            _usage_chunk = make_stream_chunk(
                                response_id,
                                model,
                                "",
                                usage=build_usage(
                                    estimate_prompt_tokens(message),
                                    estimate_tokens("".join(adapter.text_buf))
                                    + estimate_tokens("".join(adapter.thinking_buf)),
                                ),
                            )
                            _usage_chunk["choices"] = []
                            yield f"data: {orjson.dumps(_usage_chunk).decode()}\\n\\n"
                            yield "data: [DONE]\\n\\n"'''

n = src.count(old)
if n != 1:
    sys.stderr.write("anchor not unique: %d occurrences\n" % n)
    sys.exit(1)

patched = src.replace(old, new)
ast.parse(patched)  # syntax check before writing
io.open(F, "w", encoding="utf-8").write(patched)
print("PATCHED OK")
