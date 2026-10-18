export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function messageOf(data, fallback) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => `${e.loc?.slice(1).join(".") || "Input"}: ${e.msg}`)
      .join("; ");
  return data?.message || fallback;
}

export class Api {
  constructor(fetcher = (...args) => fetch(...args)) {
    this.fetcher = fetcher;
    this.refreshing = null;
    this.timeoutMs = 25000;
    this.authQueue = Promise.resolve();
    this.sessionRevision = 0;
    this.onUnauthorized = () => {};
  }

  async send(path, { method = "GET", body, signal, retry = true } = {}) {
    const sessionRevision = this.sessionRevision;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    let response,
      data,
      malformed = false;
    try {
      response = await this.fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal,
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      try {
        data = await response.json();
      } catch (error) {
        if (abort.signal.aborted) throw error;
        malformed = true;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(
        timedOut
          ? "The request took too long. Try again; the service may be waking up."
          : "Cannot reach the server. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
    if (response.status === 401 && sessionRevision !== this.sessionRevision)
      throw new ApiError(
        "The session changed while this request was loading.",
        401,
      );
    if (
      response.status === 401 &&
      retry &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/refresh") &&
      !path.startsWith("/api/auth/logout")
    ) {
      if (!this.refreshing)
        this.refreshing = this.post(
          "/api/auth/refresh",
          {},
          { retry: false },
        ).finally(() => {
          this.refreshing = null;
        });
      try {
        await this.refreshing;
      } catch (error) {
        if (error.status === 401 && sessionRevision === this.sessionRevision)
          this.onUnauthorized();
        throw error;
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return this.send(path, { method, body, signal, retry: false });
    }
    if (!response.ok) {
      if (response.status === 401 && !retry && !path.startsWith("/api/auth/"))
        this.onUnauthorized();
      throw new ApiError(
        messageOf(data, `Request failed (${response.status}).`),
        response.status,
      );
    }
    if (malformed)
      throw new ApiError(
        "The server returned an unreadable response. Please retry.",
        response.status,
      );
    return data;
  }
  get(path, options = {}) {
    return this.send(path, options);
  }
  post(path, body = {}, options = {}) {
    if (
      ["/api/auth/login", "/api/auth/logout", "/api/auth/refresh"].includes(
        path,
      )
    ) {
      const operation = this.authQueue
        .catch(() => {})
        .then(() => this.send(path, { ...options, method: "POST", body }));
      this.authQueue = operation;
      return operation;
    }
    return this.send(path, { ...options, method: "POST", body });
  }
  sessionChanged() {
    ++this.sessionRevision;
  }
  delete(path) {
    return this.send(path, { method: "DELETE" });
  }
}
