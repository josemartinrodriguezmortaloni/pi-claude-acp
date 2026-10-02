import { readFile } from "node:fs/promises";

/** The file content, or undefined when it does not exist. Other read errors propagate. */
export async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
