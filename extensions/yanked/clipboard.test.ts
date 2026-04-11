import { describe, it, expect, vi } from "vitest";
import { copyToClipboard } from "./clipboard.ts";

describe("copyToClipboard", () => {
  it("calls pbcopy on darwin", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const exec = vi.fn();

    copyToClipboard("hello", exec);

    expect(exec).toHaveBeenCalledWith("pbcopy", { input: "hello" });
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("calls clip on win32", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const exec = vi.fn();

    copyToClipboard("hello", exec);

    expect(exec).toHaveBeenCalledWith("clip", { input: "hello" });
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("tries xclip on linux, falls back to xsel", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const exec = vi.fn().mockImplementationOnce(() => {
      throw new Error("xclip not found");
    });

    copyToClipboard("hello", exec);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "xclip -selection clipboard", {
      input: "hello",
    });
    expect(exec).toHaveBeenNthCalledWith(2, "xsel --clipboard --input", {
      input: "hello",
    });
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("propagates errors from the exec function", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("pbcopy failed");
    });

    expect(() => copyToClipboard("hello", exec)).toThrow("pbcopy failed");
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
