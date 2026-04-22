import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  getLuminaVenvDir,
  getLuminaPythonBin,
  getLuminaPipBin,
  shQuote,
  buildPipInstallCommand,
  buildVenvCreateCommand,
  buildMarkitdownCheckCommand,
  parsePythonVersion,
  isPythonVersionOk,
  MIN_PYTHON_MAJOR,
  MIN_PYTHON_MINOR,
} from "./lumina-venv";

/**
 * These tests cover the *pure* surface of lumina-venv: path resolution,
 * shell quoting, and command-string construction. We do not exercise
 * `ensureLuminaVenv()` here because it would shell out and create a real
 * venv — that's covered by manual smoke tests during development.
 *
 * Pinning the command shapes matters because if we ever accidentally drop
 * the `--upgrade --quiet markitdown[all]` invocation or stop quoting the
 * venv path, users with spaces in their home dir would see opaque shell
 * errors instead of the friendly EnsureVenvResult error strings.
 */

describe("lumina-venv path helpers", () => {
  it("places the venv under ~/.lumina/venv", () => {
    expect(getLuminaVenvDir()).toBe(path.join(os.homedir(), ".lumina", "venv"));
  });

  it("python binary is bin/python on POSIX, Scripts/python.exe on Windows", () => {
    // Don't assume the test runner's platform — derive expected from the
    // venv dir we got back, which already accounts for path.sep.
    const venv = getLuminaVenvDir();
    const py = getLuminaPythonBin();
    if (process.platform === "win32") {
      expect(py).toBe(path.join(venv, "Scripts", "python.exe"));
    } else {
      expect(py).toBe(path.join(venv, "bin", "python"));
    }
  });

  it("pip binary mirrors python binary placement", () => {
    const venv = getLuminaVenvDir();
    const pip = getLuminaPipBin();
    if (process.platform === "win32") {
      expect(pip).toBe(path.join(venv, "Scripts", "pip.exe"));
    } else {
      expect(pip).toBe(path.join(venv, "bin", "pip"));
    }
  });

  it("python binary helper accepts a custom venv dir", () => {
    const customVenv = "/opt/custom-venv";
    const expected =
      process.platform === "win32"
        ? path.join(customVenv, "Scripts", "python.exe")
        : path.join(customVenv, "bin", "python");
    expect(getLuminaPythonBin(customVenv)).toBe(expected);
  });
});

describe("shQuote", () => {
  it("wraps simple paths in single quotes", () => {
    expect(shQuote("/usr/bin/python")).toBe("'/usr/bin/python'");
  });

  it("escapes embedded single quotes via close-escape-reopen", () => {
    // The classic POSIX trick: 'foo' + \' + 'bar' renders as a single
    // shell-token "foo'bar". This is the only safe way to embed a single
    // quote inside a single-quoted string.
    expect(shQuote(`/Users/o'brien/python`)).toBe(`'/Users/o'\\''brien/python'`);
  });

  it("preserves spaces (the whole point of quoting)", () => {
    expect(shQuote("/Users/jane doe/.lumina/venv/bin/python")).toBe(
      "'/Users/jane doe/.lumina/venv/bin/python'",
    );
  });

  it("preserves shell-meta chars without expansion", () => {
    // $HOME, &&, |, ` etc. all live happily inside single quotes.
    expect(shQuote("/path/$HOME/and && more")).toBe(
      "'/path/$HOME/and && more'",
    );
  });
});

describe("parsePythonVersion", () => {
  it("extracts major.minor from standard `python --version` output", () => {
    expect(parsePythonVersion("Python 3.11.6")).toEqual({ major: 3, minor: 11 });
  });

  it("tolerates trailing whitespace + CRLF (Windows)", () => {
    expect(parsePythonVersion("Python 3.12.2\r\n")).toEqual({ major: 3, minor: 12 });
  });

  it("returns null for non-Python strings (guards against shim output)", () => {
    expect(parsePythonVersion("bash: python3: command not found")).toBeNull();
    expect(parsePythonVersion("")).toBeNull();
  });
});

describe("isPythonVersionOk", () => {
  it("accepts versions at or above the current minimum", () => {
    expect(
      isPythonVersionOk({ major: MIN_PYTHON_MAJOR, minor: MIN_PYTHON_MINOR }),
    ).toBe(true);
    expect(
      isPythonVersionOk({ major: MIN_PYTHON_MAJOR, minor: MIN_PYTHON_MINOR + 3 }),
    ).toBe(true);
    expect(isPythonVersionOk({ major: MIN_PYTHON_MAJOR + 1, minor: 0 })).toBe(true);
  });

  it("rejects anything below the minimum (stale venvs must be recreated)", () => {
    expect(
      isPythonVersionOk({
        major: MIN_PYTHON_MAJOR,
        minor: MIN_PYTHON_MINOR - 1,
      }),
    ).toBe(false);
    expect(isPythonVersionOk({ major: 2, minor: 7 })).toBe(false);
  });

  it("rejects null (parse failure → rebuild, don't limp along)", () => {
    expect(isPythonVersionOk(null)).toBe(false);
  });
});

describe("command builders", () => {
  it("pip install always uses python -m pip + markitdown[all]", () => {
    // We avoid shelling out to bare `pip` because freshly-created venvs
    // sometimes don't have the pip binary on PATH yet. python -m pip
    // dodges that. Pinning the command shape so future refactors don't
    // silently regress this invariant.
    const cmd = buildPipInstallCommand("/v/bin/python");
    expect(cmd).toBe(
      "'/v/bin/python' -m pip install --upgrade --quiet markitdown[all]",
    );
  });

  it("pip install command quotes the python path (handles spaces)", () => {
    const cmd = buildPipInstallCommand("/Users/jane doe/.lumina/venv/bin/python");
    expect(cmd).toContain("'/Users/jane doe/.lumina/venv/bin/python'");
    expect(cmd).toContain("markitdown[all]");
  });

  it("venv create command uses python -m venv with both args quoted", () => {
    const cmd = buildVenvCreateCommand("/usr/bin/python3", "/home/u/.lumina/venv");
    expect(cmd).toBe("'/usr/bin/python3' -m venv '/home/u/.lumina/venv'");
  });

  it("markitdown check imports the package and prints version", () => {
    // The model relies on this command's exit status to know whether the
    // venv is healthy. If we ever swap to `pip show markitdown` or similar
    // we'd lose the import-time smoke test (corrupt installs that fail at
    // import would slip through). Keep it as `import markitdown`.
    const cmd = buildMarkitdownCheckCommand("/v/bin/python");
    expect(cmd).toBe(
      `'/v/bin/python' -c "import markitdown; print(markitdown.__version__)"`,
    );
  });
});
