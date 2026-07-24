import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const COMPOSE_FILE = path.join(repoRoot, "docker-compose.yml");
export const ENV_FILE = path.join(repoRoot, ".env");

export class ComposeError extends Error {}

/** Запускает `docker compose` и возвращает stdout. Бросает ComposeError при ненулевом коде. */
export async function compose(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  const fullArgs = ["compose", "--env-file", ENV_FILE, "-f", COMPOSE_FILE, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn("docker", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      reject(new ComposeError(`docker не найден: ${error.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve(stdout.trim());
      } else {
        reject(
          new ComposeError(
            `docker ${fullArgs.join(" ")} завершился с кодом ${code}:\n${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

export async function composeUp(): Promise<void> {
  await compose(["up", "-d", "--wait"]);
}

export async function composeDown(): Promise<void> {
  await compose(["down"]);
}

/** Статус контейнера: running/exited/... или null, если контейнера нет. */
export async function composeStatus(): Promise<{
  state: string;
  health: string;
} | null> {
  const out = await compose(
    ["ps", "-a", "--format", "{{.State}} {{.Health}}", "surrealdb"],
    { allowFailure: true },
  );
  if (!out) return null;
  const [state = "unknown", health = ""] = out.split(/\s+/);
  return { state, health: health || "none" };
}

export async function composeLogs(tail = 100): Promise<string> {
  return compose(["logs", "--tail", String(tail), "surrealdb"], {
    allowFailure: true,
  });
}
