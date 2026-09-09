import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const INSTALLATION_HELP = [
  "Если Docker Desktop и OrbStack не установлены, установите один из них:",
  "  OrbStack (macOS): https://orbstack.dev/download",
  "  Docker Desktop: https://docs.docker.com/desktop/setup/install/",
  "Откройте установленное приложение и завершите первоначальную настройку.",
  "Убедитесь, что команда docker доступна в PATH, затем повторите bun sync.",
].join("\n");

export interface DockerRuntimeDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Start only the runtime selected by Docker's effective endpoint, never switch contexts. */
export async function ensureDockerRuntime(
  progress: (detail: string) => void,
  dependencies: DockerRuntimeDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const run = dependencies.run ?? (async (file, args, timeoutMs) => {
    const result = await exec(file, args, {
      env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
    });
    return result.stdout.trim();
  });
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? Bun.sleep;
  progress("Проверка Docker API");
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], 1_000);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Docker CLI не установлен или отсутствует в PATH.\n${INSTALLATION_HELP}`, { cause: error });
    }
  }
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Docker API недоступен; запустите Docker daemon вручную на этой платформе");
  }

  // DOCKER_CONTEXT overrides DOCKER_HOST, matching Docker CLI precedence.
  let endpoint = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
  if (!endpoint) {
    const contexts = JSON.parse(await run(
      "docker", ["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : [])], 3_000,
    )) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
    endpoint = contexts[0]?.Endpoints?.docker?.Host;
  }
  let app: string;
  if (endpoint?.startsWith("unix://") && endpoint.endsWith("/.orbstack/run/docker.sock")) {
    app = "OrbStack";
  } else if (endpoint?.startsWith("unix://") && (
    endpoint.endsWith("/.docker/run/docker.sock") || endpoint.endsWith("/.docker/desktop/docker.sock")
  )) {
    app = "Docker";
  } else {
    throw new Error(`Docker API недоступен; выбранный endpoint не распознан как локальный OrbStack или Docker Desktop. Запустите его вручную.\n${INSTALLATION_HELP}`);
  }

  progress(`Docker API недоступен: запуск ${app}; проверка каждую секунду, до 60 секунд`);
  try {
    await run("open", ["-g", "-a", app], 5_000);
  } catch (error) {
    throw new Error(`Не удалось запустить ${app}. Откройте приложение вручную и повторите bun sync.\n${INSTALLATION_HELP}`, { cause: error });
  }
  const deadline = now() + 60_000;
  while (now() < deadline) {
    const probeStarted = now();
    try {
      await run("docker", ["info", "--format", "{{.ServerVersion}}"], Math.max(1, Math.min(1_000, deadline - probeStarted)));
      return;
    } catch {
      // Keep a one-second cadence including probe time, not one second after it.
      const delay = Math.min(probeStarted + 1_000, deadline) - now();
      if (delay > 0) await sleep(delay);
    }
  }
  throw new Error(`${app}: Docker API не стал доступен за 60 секунд. Включите Docker вручную (откройте ${app}), дождитесь готовности и повторите bun sync.`);
}
