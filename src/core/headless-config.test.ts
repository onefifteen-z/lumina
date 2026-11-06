import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { HeadlessConfigError, parseCliArgs, resolveHeadlessConfig } from "./headless-config";

let tmp: string;
let vault: string;
let userData: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-headless-"));
  vault = path.join(tmp, "vault");
  userData = path.join(tmp, "userdata");
  fs.mkdirSync(path.join(vault, "wiki"), { recursive: true });
  fs.mkdirSync(userData);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeAppConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(userData, "llm-wiki-config.json"), JSON.stringify(cfg));
}

describe("parseCliArgs", () => {
  it("parses --vault in both forms and --allow-write", () => {
    expect(parseCliArgs(["--vault", "/a", "--allow-write"])).toEqual({ vault: "/a", allowWrite: true });
    expect(parseCliArgs(["--vault=/b"])).toEqual({ vault: "/b", allowWrite: false });
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(HeadlessConfigError);
    expect(() => parseCliArgs(["--vault"])).toThrow(/requires a value/);
  });
});

describe("resolveHeadlessConfig", () => {
  it("prefers --vault over LUMINA_VAULT over the app config", () => {
    const other = path.join(tmp, "other");
    fs.mkdirSync(path.join(other, "wiki"), { recursive: true });
    writeAppConfig({ vaultPath: other });
    const env = { LUMINA_VAULT: other };
    expect(resolveHeadlessConfig(["--vault", vault], env, [userData]).vaultPath).toBe(vault);
    expect(resolveHeadlessConfig([], { LUMINA_VAULT: vault }, [userData]).vaultPath).toBe(vault);
    expect(resolveHeadlessConfig([], {}, [userData]).vaultPath).toBe(other);
  });

  it("reads qmdSearch and mcpServer.allowWrite from the app config", () => {
    writeAppConfig({ vaultPath: vault, qmdSearch: { enabled: true }, mcpServer: { allowWrite: true } });
    const cfg = resolveHeadlessConfig([], {}, [path.join(tmp, "missing"), userData]);
    expect(cfg.userDataDir).toBe(userData);
    expect(cfg.qmdSearch).toEqual({ enabled: true, mode: "hybrid", autoEmbed: true });
    expect(cfg.allowWrite).toBe(true);
  });

  it("defaults to read-only and qmd disabled without an app config", () => {
    const cfg = resolveHeadlessConfig(["--vault", vault], {}, [userData]);
    expect(cfg.userDataDir).toBeNull();
    expect(cfg.allowWrite).toBe(false);
    expect(cfg.qmdSearch.enabled).toBe(false);
  });

  it("merges the app's vault history with an explicit --vault", () => {
    const other = path.join(tmp, "other");
    fs.mkdirSync(path.join(other, "wiki"), { recursive: true });
    writeAppConfig({ vaultHistory: [{ path: other, name: "Other" }] });
    const cfg = resolveHeadlessConfig(["--vault", vault], {}, [userData]);
    expect(cfg.vaultPath).toBe(vault);
    expect(cfg.vaults).toEqual([
      { path: vault, name: "vault" },
      { path: other, name: "Other" },
    ]);
  });

  it("makes --vault optional when the app has a vault history", () => {
    writeAppConfig({ vaultPath: path.join(tmp, "deleted"), vaultHistory: [{ path: vault, name: "Main" }] });
    const cfg = resolveHeadlessConfig([], {}, [userData]);
    expect(cfg.vaultPath).toBeNull();
    expect(cfg.vaults).toEqual([{ path: vault, name: "Main" }]);
  });

  it("does not duplicate a --vault that is already in the history", () => {
    writeAppConfig({ vaultHistory: [{ path: vault, name: "Main" }] });
    expect(resolveHeadlessConfig(["--vault", vault], {}, [userData]).vaults).toEqual([{ path: vault, name: "Main" }]);
  });

  it("fails clearly without a vault or with a non-vault folder", () => {
    expect(() => resolveHeadlessConfig([], {}, [userData])).toThrow(/No vault configured/);
    expect(() => resolveHeadlessConfig(["--vault", tmp], {}, [userData])).toThrow(/not a Lumina vault/);
  });
});
