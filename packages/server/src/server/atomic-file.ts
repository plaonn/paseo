import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let tempFile: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    await fs.writeFile(tempPath, data, "utf8");
    tempFile = await fs.open(tempPath, "r+");
    await tempFile.sync();
    await tempFile.close();
    tempFile = null;
    await fs.rename(tempPath, filePath);
    let directory: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      directory = await fs.open(path.dirname(filePath), "r");
      await directory.sync();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") {
        throw error;
      }
    } finally {
      await directory?.close();
    }
  } catch (error) {
    await tempFile?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}
