"""Publication-hygiene scrub gate for anything this site ships to a visitor.

WHY THIS EXISTS
---------------
On 2026-07-25 the pre-rendered methodology pages (`src/content/methods_*.html`) were
found shipping internal build artefacts to public visitors: a literal Windows
interpreter path, absolute workspace output paths, an internal container hostname, and
internal research-archive document ids. They were reachable by clicking a Methodology
tab on the live site. Hand-patching the generated HTML would have been
silently reverted by the next `build_content.py` run, so the fix went into the SOURCE
markdown -- and this module is the gate that stops it coming back.

WHAT IT IS
----------
A single, self-contained pattern set. It is deliberately NOT an import of any internal
tool: this file mirrors into the public repo, so it must run for an outside cloner with
nothing but the standard library (Publication Hygiene Standard s4a, internal-
infrastructure decoupling).

The pattern set is the union of:
  * PUBLICATION_HYGIENE_STANDARD s1 / s4a -- absolute workspace paths are FAIL-severity;
    no internal paths, usernames or internal cross-references in anything that ships.
  * CODE_DATA_FIRST_STANDARD s4.2 -- the knowledge-base artefact grep set
    (`Knowledge_Base/`, `/KB/`, `FULL_TEXT_chunks`, `CSV_Tables/table_`,
    `equations_chunks`, `figures_chunks`, `RDB_METADATA`, chunk-marker residue,
    HDARP/Hopper batch ids).
  * the same FAIL list the Anu publish auditor applies to published packages
    (drive-letter paths, `andenick`), restricted here to forms that cannot collide with
    the site's own legitimate public strings (e.g. `andenick@` rather than bare
    `andenick`, which appears in the public GitHub URL).
  * this deployment's own internal infrastructure: private RFC1918 addresses, the
    internal OTP container/network names, and the box's home-directory site root.

USAGE
-----
    from hygiene import assert_clean
    assert_clean([out_path], label="methods_bus.html")   # raises SystemExit(2) on a hit

or standalone, over any built tree:

    python site/tools/hygiene.py site/frontend/src/content
    python site/tools/hygiene.py site/frontend/dist/assets site/frontend/dist/index.html

Exit code 0 = clean, 1 = leak found (CLI), SystemExit(2) = leak found (in-build gate).
A build that would ship a leak MUST exit non-zero. This gate has a proven negative
control: re-introduce any pattern below into a source doc and the content build fails.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

__all__ = ["PATTERNS", "scan_text", "scan_paths", "assert_clean", "assert_clean_text",
           "main"]

# (compiled pattern, human explanation). Every one of these is FAIL severity: a build
# that would ship any of them must not complete.
# A drive-letter path must be preceded by a non-word char (keeps it off "https://") and
# FOLLOWED by a path-ish character. That trailing lookahead is what separates a real
# absolute path from a minified JavaScript regex literal such as `segmentRE:/[MLHV]/`
# or `DOT_RE:/-dot/`, which look like drive-letter paths to a naive matcher. A real
# path always continues into a directory or file name; those do not.
_PATH_TAIL = r"(?=[\w~.$])"

PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # -- absolute workspace / machine paths (PUBLICATION_HYGIENE_STANDARD s1, s4a) ----
    (re.compile(r"(?<![\w:])C:[\\/]" + _PATH_TAIL), "absolute C: path"),
    (re.compile(r"(?<![\w:])D:[\\/]Arcanum"), "absolute D:/Arcanum workspace path"),
    (re.compile(r"(?<![\w:])E:[\\/]" + _PATH_TAIL), "absolute E: path"),
    (re.compile(r"(?<![\w:])F:[\\/]" + _PATH_TAIL), "absolute F: path"),
    # catch-all for every other drive letter
    (re.compile(r"(?<![\w:])[A-Za-z]:[\\/]" + _PATH_TAIL), "drive-letter absolute path"),
    (re.compile(r"python\.exe"), "interpreter executable path"),
    (re.compile(r"Outputs[\\/]NYCPlatform"), "internal workspace output path"),
    (re.compile(r"Technical[\\/]NYCPlatform"), "internal workspace source path"),
    (re.compile(r"[\\/]Council[\\/]"), "internal Council directory"),
    # -- knowledge-base artefacts (CODE_DATA_FIRST_STANDARD s4.2) --------------------
    (re.compile(r"Knowledge_Base[\\/]"), "KB artefact path"),
    (re.compile(r"(?<![\w.])/KB/"), "KB artefact path"),
    (re.compile(r"FULL_TEXT_chunks"), "KB extraction filename"),
    (re.compile(r"CSV_Tables[\\/]table_"), "KB extraction filename"),
    # A bare KB table-extraction filename (table_007_p24.csv). The CSV_Tables/ prefix is
    # usually gone by the time one is quoted in a provenance field, so the prefixed
    # pattern above does not see it.
    (re.compile(r"\btable_\d{3}_p\d+"), "KB extraction filename"),
    (re.compile(r"equations_chunks"), "KB extraction filename"),
    (re.compile(r"figures_chunks"), "KB extraction filename"),
    (re.compile(r"RDB_METADATA"), "KB enrichment sidecar"),
    (re.compile(r"<!-- chunk"), "chunk-marker residue"),
    (re.compile(r"\[CHUNK_"), "chunk-marker residue"),
    (re.compile(r"\bchunk_\d+"), "chunk-marker residue"),
    (re.compile(r"\bBATCH_\d{3,}"), "extraction batch id"),
    (re.compile(r"\bHDARP\b|\bSPHDARP\b"), "internal extraction-method name"),
    (re.compile(r"Jane KB|Jane Knowledge Base"), "internal corpus codename"),
    # NO trailing \b. The ids occur bare (DOC0343) AND suffixed with the extraction hash
    # (DOC0359_b11c320e); requiring a word boundary matched only the bare form, which is
    # how 15 suffixed ids survived in a publicly-served JSON audit trail.
    (re.compile(r"\bDOC\d{4}"), "internal KB document id"),
    # -- this deployment's internal infrastructure -----------------------------------
    (re.compile(r"andenick@"), "operator account"),
    (re.compile(r"\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "private IP address"),
    (re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"), "private IP address"),
    (re.compile(r"nycvis-otp"), "internal container hostname"),
    (re.compile(r"homelab_default"), "internal docker network"),
    (re.compile(r"~/sites/"), "deploy-host filesystem path"),
]

# ---------------------------------------------------------------- DELIBERATE ALLOWANCES
#
# These are NOT oversights. They were reviewed on 2026-07-25 and kept ON PURPOSE. There is
# no pattern above that matches them, and none should be added -- this note exists so a
# later reader does not "tidy up" by adding one.
#
#   JaneNYCPoller, JaneNYCGtfsSnap, JaneNYCDerive, JaneNYCDerivedSync, JaneNYCCanary
#       -- the scheduled-job names, which appear in methods_changes and methods_derive2.
#       They are KEPT because they carry information a reader actually wants: which job
#       refreshes which surface, and how often. Publication hygiene is about artefacts that
#       are meaningless-but-revealing to an outsider (our paths, our interpreter, our
#       archive ids). A job name that explains "this dataset is rebuilt every six hours" is
#       the opposite: meaningful to the reader and revealing of nothing. It is not a path,
#       not a credential, not a host, and not an archive reference. Leave them.
#
# If you are tempted to forbid a string, ask the test these allowances pass: does removing
# it protect anything, or does it only cost the reader an explanation?

# Files worth reading when a directory is handed to the CLI.
#
# CODE COUNTS. The first cut of this list held only web/markup/data suffixes, which meant a
# repo-wide sweep silently skipped every .py and .ps1 -- and three absolute workspace paths
# (one of them a full `D:/Arcanum/...` literal) were sitting in tracked Python files while
# the sweep reported PASS. A gate that does not read a file cannot fail on it. Add a suffix
# here before assuming a clean sweep covers a new file type.
TEXT_SUFFIXES = {
    # web / markup / data
    ".html", ".htm", ".json", ".js", ".mjs", ".cjs", ".css", ".md", ".txt",
    ".ts", ".tsx", ".jsx", ".svg", ".xml", ".csv", ".geojson",
    # code
    ".py", ".pyi", ".sh", ".ps1", ".psm1", ".bat", ".cmd", ".sql", ".r", ".rmd",
    # config / metadata (an outsider reads these too)
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".cff", ".example",
    ".dockerfile", ".env",
}


class Finding(tuple):
    """(path, line_no, why, excerpt) -- a tuple so it prints and sorts plainly."""

    __slots__ = ()


def scan_text(text: str, label: str = "<text>") -> list[Finding]:
    """Return every hygiene violation in `text`, one Finding per matching line."""
    out: list[Finding] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for pat, why in PATTERNS:
            m = pat.search(line)
            if m:
                start = max(0, m.start() - 40)
                excerpt = line[start:m.end() + 60].strip()
                out.append(Finding((label, lineno, why, excerpt)))
                break  # one finding per line is enough to fail the build
    return out


def _is_self(p: Path) -> bool:
    """This file necessarily CONTAINS every pattern it forbids -- it is the deny-list.

    Scanning it would report ~30 findings on every repo-wide sweep and train a reader to
    ignore the output, which is how a gate stops working. This is the ONLY self-exemption:
    it applies to one filename, not to a directory or a pattern.
    """
    return p.name == "hygiene.py"


def _is_vendor(p: Path) -> bool:
    """Third-party minified bundles (e.g. plotly.min-HASH.js) are not our prose.

    They cannot contain our workspace strings, and their minified regex literals are a
    permanent source of drive-letter false positives. Our OWN built chunks are named
    `<Name>-<hash>.js` and are never skipped. Skips are reported, never silent.
    """
    return ".min." in p.name or ".min-" in p.name


# Never walked: third-party trees and caches. Nothing we author lives here, and a
# dependency's own Windows-path documentation is not our leak.
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", ".vite",
             ".mypy_cache", ".pytest_cache"}


def _iter_files(target: Path, skipped: list[Path] | None = None):
    if target.is_dir():
        for p in sorted(target.rglob("*")):
            if SKIP_DIRS.intersection(p.parts):
                continue
            if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES:
                if _is_self(p):
                    continue
                if _is_vendor(p):
                    if skipped is not None:
                        skipped.append(p)
                    continue
                yield p
    elif target.is_file():
        yield target


def scan_paths(paths, label: str | None = None,
               skipped: list[Path] | None = None) -> list[Finding]:
    """Scan files and/or directories; returns all findings."""
    out: list[Finding] = []
    for raw in paths:
        for p in _iter_files(Path(raw), skipped):
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:  # unreadable file is not a hygiene finding
                print(f"  hygiene: could not read {p}: {exc}", file=sys.stderr)
                continue
            out.extend(scan_text(text, label or p.as_posix()))
    return out


def _fail(findings: list[Finding]) -> None:
    print("", file=sys.stderr)
    print("PUBLICATION HYGIENE GATE: FAIL — refusing to ship internal artefacts.",
          file=sys.stderr)
    for where, lineno, why, excerpt in findings:
        print(f"  {where}:{lineno}: {why}\n      {excerpt}", file=sys.stderr)
    print(f"  {len(findings)} violation(s). Fix the SOURCE document (not the generated "
          f"output — it is regenerated), then rebuild.", file=sys.stderr)
    sys.stderr.flush()
    raise SystemExit(2)


def assert_clean(paths, label: str | None = None) -> None:
    """Gate over files/directories: abort the build (SystemExit 2) on any finding."""
    findings = scan_paths(paths, label)
    if findings:
        _fail(findings)


def assert_clean_text(text: str, label: str) -> None:
    """Gate over text that is ABOUT to be written. Abort before it reaches disk."""
    findings = scan_text(text, label)
    if findings:
        _fail(findings)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 0
    skipped: list[Path] = []
    findings = scan_paths(argv[1:], skipped=skipped)
    for p in skipped:
        print(f"skipped (vendored minified bundle): {p.as_posix()}")
    for where, lineno, why, excerpt in findings:
        print(f"{where}:{lineno}: {why}\n    {excerpt}")
    if findings:
        print(f"\nFAIL: {len(findings)} publication-hygiene violation(s).")
        return 1
    print("PASS: no publication-hygiene violations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
