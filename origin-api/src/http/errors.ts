export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class DeadlineError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = "DeadlineError";
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label)), ms);
  });
  void promise.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function withFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return withDeadline(promise, ms, "optional").catch(() => fallback);
}
