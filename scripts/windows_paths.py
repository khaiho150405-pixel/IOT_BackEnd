"""Keep GCC's child-process command below Windows' 32767-character limit.

Long PlatformIO package paths (especially version suffixes) are repeated for
each ESP-IDF include directory. Use existing Windows short names when available.
This changes build paths only, without moving or editing installed packages.
"""
import os

Import("env")

if os.name == "nt":
    import ctypes

    get_short_path = ctypes.windll.kernel32.GetShortPathNameW
    get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
    get_short_path.restype = ctypes.c_uint

    def shorten(build_env, value):
        original = build_env.subst(str(value))
        absolute = os.path.abspath(original)
        buffer = ctypes.create_unicode_buffer(32768)
        size = get_short_path(absolute, buffer, len(buffer))
        return buffer.value.replace("\\", "/") if 0 < size < len(buffer) else value

    def short_include_flags(target, source, env, for_signature):
        paths = []
        seen = set()
        for path in env.get("CPPPATH", []):
            path = str(shorten(env, path))
            if path.lower() not in seen:
                seen.add(path.lower())
                paths.append("-I" + path)
        return paths

    # Evaluate at command expansion, after PlatformIO merges library paths.
    env.Replace(_CPPINCFLAGS=short_include_flags)
