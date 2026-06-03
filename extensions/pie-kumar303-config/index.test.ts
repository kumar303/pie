import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverExtensions,
  discoverSkills,
  formatChooserLeftLines,
  getInstallState,
  installExtension,
  installSkill,
  removeExtension,
  removeSkill,
  removeSkillFrontmatterRuleFromRenderedMarkdown,
} from "./index.ts";

/** Fail the test if an unexpected error is reported. */
function failOnError(message: string): void {
  throw new Error(`Unexpected error: ${message}`);
}

describe("discoverExtensions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    const extDir = join(tmpDir, "extensions");
    mkdirSync(extDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists extension directories excluding the config extension", () => {
    mkdirSync(join(tmpDir, "extensions", "git"));
    mkdirSync(join(tmpDir, "extensions", "brain"));
    mkdirSync(join(tmpDir, "extensions", "pie-kumar303-config"));

    const exts = discoverExtensions(join(tmpDir, "extensions"), failOnError);
    const names = exts.map((e) => e.name);
    expect(names).toContain("git");
    expect(names).toContain("brain");
    expect(names).not.toContain("pie-kumar303-config");
  });

  it("returns empty array when no extensions exist", () => {
    const exts = discoverExtensions(join(tmpDir, "extensions"), failOnError);
    expect(exts).toEqual([]);
  });

  it("throws when extensions directory does not exist", () => {
    expect(() =>
      discoverExtensions(join(tmpDir, "nonexistent"), failOnError),
    ).toThrow(/does not exist/);
  });

  it("ignores non-directory entries", () => {
    writeFileSync(join(tmpDir, "extensions", "not-a-dir.txt"), "hi");
    mkdirSync(join(tmpDir, "extensions", "real-ext"));

    const exts = discoverExtensions(join(tmpDir, "extensions"), failOnError);
    expect(exts).toEqual([
      { name: "real-ext", path: join(tmpDir, "extensions", "real-ext") },
    ]);
  });

  it("includes README content when present", () => {
    mkdirSync(join(tmpDir, "extensions", "my-ext"));
    writeFileSync(
      join(tmpDir, "extensions", "my-ext", "README.md"),
      "# My Extension\nDoes stuff.",
    );

    const exts = discoverExtensions(join(tmpDir, "extensions"), failOnError);
    expect(exts[0].readme).toBe("# My Extension\nDoes stuff.");
  });

  it("sets readme to undefined when no README exists", () => {
    mkdirSync(join(tmpDir, "extensions", "no-readme"));

    const exts = discoverExtensions(join(tmpDir, "extensions"), failOnError);
    expect(exts[0].readme).toBeUndefined();
  });

  it("reports errors for unreadable READMEs", () => {
    mkdirSync(join(tmpDir, "extensions", "bad-readme"));
    // Create a directory named README.md so readFileSync will fail
    mkdirSync(join(tmpDir, "extensions", "bad-readme", "README.md"));

    const errors: string[] = [];
    discoverExtensions(join(tmpDir, "extensions"), (err) => errors.push(err));
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/bad-readme/);
    expect(errors[0]).toMatch(/README/);
  });
});

describe("discoverSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    mkdirSync(join(tmpDir, "skills"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists skill directories that contain SKILL.md", () => {
    mkdirSync(join(tmpDir, "skills", "test-break-fix"));
    writeFileSync(
      join(tmpDir, "skills", "test-break-fix", "SKILL.md"),
      "---\nname: test-break-fix\ndescription: Review tests.\n---\n\nBody",
    );
    mkdirSync(join(tmpDir, "skills", "not-a-skill"));

    const skills = discoverSkills(join(tmpDir, "skills"), failOnError);
    expect(skills).toEqual([
      {
        name: "test-break-fix",
        path: join(tmpDir, "skills", "test-break-fix"),
        readme:
          "---\nname: test-break-fix\ndescription: Review tests.\n---\n\nBody",
      },
    ]);
  });

  it("throws when skills directory does not exist", () => {
    expect(() => discoverSkills(join(tmpDir, "missing"), failOnError)).toThrow(
      /does not exist/,
    );
  });
});

describe("formatChooserLeftLines", () => {
  it("groups extensions and skills under separate headings", () => {
    const lines = formatChooserLeftLines([
      {
        name: "git",
        path: "/repo/extensions/git",
        type: "extension",
        checked: false,
        wasInstalled: false,
      },
      {
        name: "test-break-fix",
        path: "/repo/skills/test-break-fix",
        type: "skill",
        checked: true,
        wasInstalled: true,
      },
    ]);

    expect(lines).toEqual([
      "Extensions",
      "  ☐ git",
      "Skills",
      "  ☑ test-break-fix",
    ]);
  });
});

describe("removeSkillFrontmatterRuleFromRenderedMarkdown", () => {
  it("removes only the rendered horizontal rule for skill frontmatter", () => {
    const markdown =
      "---\nname: test-break-fix\ndescription: Review tests.\n---\n\nYou are assessing tests.";

    expect(
      removeSkillFrontmatterRuleFromRenderedMarkdown(markdown, [
        "────────────────",
        "name: test-break-fix",
        "description: Review tests.",
        "You are assessing tests.",
      ]),
    ).toEqual([
      "name: test-break-fix",
      "description: Review tests.",
      "You are assessing tests.",
    ]);
  });

  it("leaves rendered markdown unchanged when there is no frontmatter", () => {
    expect(
      removeSkillFrontmatterRuleFromRenderedMarkdown("# Title\n\nBody", [
        "Title",
        "Body",
      ]),
    ).toEqual(["Title", "Body"]);
  });
});

describe("getInstallState", () => {
  let tmpDir: string;
  let repoExtDir: string;
  let agentExtDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    repoExtDir = join(tmpDir, "repo", "extensions");
    agentExtDir = join(tmpDir, "agent", "extensions");
    mkdirSync(repoExtDir, { recursive: true });
    mkdirSync(agentExtDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when symlink points to the repo extension", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    symlinkSync(extPath, join(agentExtDir, "git"));

    expect(getInstallState("git", extPath, agentExtDir)).toBe(true);
  });

  it("returns false when no symlink exists", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);

    expect(getInstallState("git", extPath, agentExtDir)).toBe(false);
  });

  it("returns false when symlink points elsewhere", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    const otherDir = join(tmpDir, "other");
    mkdirSync(otherDir);
    symlinkSync(otherDir, join(agentExtDir, "git"));

    expect(getInstallState("git", extPath, agentExtDir)).toBe(false);
  });

  it("returns false when path exists but is not a symlink", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    mkdirSync(join(agentExtDir, "git"));

    expect(getInstallState("git", extPath, agentExtDir)).toBe(false);
  });

  it("returns false for broken symlinks", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    const deadTarget = join(tmpDir, "gone");
    // Create a symlink to a target that doesn't exist
    symlinkSync(deadTarget, join(agentExtDir, "git"));

    expect(getInstallState("git", extPath, agentExtDir)).toBe(false);
  });
});

describe("installExtension", () => {
  let tmpDir: string;
  let repoExtDir: string;
  let agentExtDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    repoExtDir = join(tmpDir, "repo", "extensions");
    agentExtDir = join(tmpDir, "agent", "extensions");
    mkdirSync(repoExtDir, { recursive: true });
    mkdirSync(agentExtDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a symlink from agent dir to repo extension", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);

    const result = installExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();

    const linkPath = join(agentExtDir, "git");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(extPath);
  });

  it("creates agent extensions directory if it does not exist", () => {
    const missingDir = join(tmpDir, "missing", "extensions");
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);

    const result = installExtension("git", extPath, missingDir);
    expect(result).toBeNull();
    expect(existsSync(join(missingDir, "git"))).toBe(true);
  });

  it("returns error when a non-symlink already exists at the target", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    mkdirSync(join(agentExtDir, "git"));

    const result = installExtension("git", extPath, agentExtDir);
    expect(result).toContain("not a symlink");
  });

  it("replaces existing symlink if it points to same target", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    symlinkSync(extPath, join(agentExtDir, "git"));

    const result = installExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();
    expect(readlinkSync(join(agentExtDir, "git"))).toBe(extPath);
  });

  it("replaces existing symlink pointing elsewhere", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    const otherDir = join(tmpDir, "other");
    mkdirSync(otherDir);
    symlinkSync(otherDir, join(agentExtDir, "git"));

    const result = installExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();
    expect(readlinkSync(join(agentExtDir, "git"))).toBe(extPath);
  });

  it("replaces broken symlink", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    const deadTarget = join(tmpDir, "gone");
    symlinkSync(deadTarget, join(agentExtDir, "git"));

    const result = installExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();
    expect(readlinkSync(join(agentExtDir, "git"))).toBe(extPath);
  });
});

describe("installSkill/removeSkill", () => {
  let tmpDir: string;
  let repoSkillsDir: string;
  let agentSkillsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    repoSkillsDir = join(tmpDir, "repo", "skills");
    agentSkillsDir = join(tmpDir, "agent", "skills");
    mkdirSync(repoSkillsDir, { recursive: true });
    mkdirSync(agentSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and removes a symlink from the Pi agent skills directory to the repo skill", () => {
    const skillPath = join(repoSkillsDir, "test-break-fix");
    mkdirSync(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "---\nname: test\n---\n");

    expect(
      installSkill("test-break-fix", skillPath, agentSkillsDir),
    ).toBeNull();
    expect(
      lstatSync(join(agentSkillsDir, "test-break-fix")).isSymbolicLink(),
    ).toBe(true);
    expect(readlinkSync(join(agentSkillsDir, "test-break-fix"))).toBe(
      skillPath,
    );

    expect(removeSkill("test-break-fix", skillPath, agentSkillsDir)).toBeNull();
    expect(existsSync(join(agentSkillsDir, "test-break-fix"))).toBe(false);
  });
});

describe("removeExtension", () => {
  let tmpDir: string;
  let repoExtDir: string;
  let agentExtDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pie-config-test-"));
    repoExtDir = join(tmpDir, "repo", "extensions");
    agentExtDir = join(tmpDir, "agent", "extensions");
    mkdirSync(repoExtDir, { recursive: true });
    mkdirSync(agentExtDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a symlink that points to the repo extension", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    symlinkSync(extPath, join(agentExtDir, "git"));

    const result = removeExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();
    expect(existsSync(join(agentExtDir, "git"))).toBe(false);
  });

  it("returns null when symlink does not exist (already removed)", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);

    const result = removeExtension("git", extPath, agentExtDir);
    expect(result).toBeNull();
  });

  it("refuses to remove a non-symlink", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    mkdirSync(join(agentExtDir, "git"));

    const result = removeExtension("git", extPath, agentExtDir);
    expect(result).toContain("not a symlink");
  });

  it("refuses to remove a symlink that points elsewhere", () => {
    const extPath = join(repoExtDir, "git");
    mkdirSync(extPath);
    const otherDir = join(tmpDir, "other");
    mkdirSync(otherDir);
    symlinkSync(otherDir, join(agentExtDir, "git"));

    const result = removeExtension("git", extPath, agentExtDir);
    expect(result).toContain("points to a different location");
    // The symlink should NOT be removed
    expect(lstatSync(join(agentExtDir, "git")).isSymbolicLink()).toBe(true);
  });
});
