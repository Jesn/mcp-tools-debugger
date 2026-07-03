import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ClientRequest,
  Result,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  Request,
  ServerCapabilities,
  McpError,
  ErrorCode,
  CancelledNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  Progress,
  LoggingLevel,
  Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AnySchema,
  SchemaOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/lib/hooks/useToast";
import { ConnectionStatus, CLIENT_IDENTITY } from "../constants";
import { isConnectionAuthError } from "../connectionAuthErrors";
import { Notification } from "../notificationTypes";
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  clearClientInformationFromSessionStorage,
  InspectorOAuthClientProvider,
  saveClientInformationToSessionStorage,
  saveScopeToSessionStorage,
  clearScopeFromSessionStorage,
  discoverScopes,
} from "../auth";
import { createProxyFetch } from "../proxyFetch";
import {
  getMCPProxyAddress,
  getMCPServerRequestMaxTotalTimeout,
  resetRequestTimeoutOnProgress,
  getMCPProxyAuthToken,
} from "@/utils/configUtils";
import { getMCPServerRequestTimeout } from "@/utils/configUtils";
import { InspectorConfig } from "../configurationTypes";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CustomHeaders } from "../types/customHeaders";
import { resolveRefsInMessage } from "@/utils/schemaUtils";
import {
  explainConnectionFailure,
  type ConnectionDiagnostic,
} from "../connectionDiagnostics";

interface UseConnectionOptions {
  transportType: "stdio" | "sse" | "streamable-http";
  command: string;
  args: string;
  sseUrl: string;
  env: Record<string, string>;
  // Custom headers support
  customHeaders?: CustomHeaders;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScope?: string;
  config: InspectorConfig;
  connectionType?: "direct" | "proxy";
  onNotification?: (notification: Notification) => void;
  onStdErrNotification?: (notification: Notification) => void;
  defaultLoggingLevel?: LoggingLevel;
  serverImplementation?: Implementation;
  metadata?: Record<string, string>;
}

export function useConnection({
  transportType,
  command,
  args,
  sseUrl,
  env,
  customHeaders,
  oauthClientId,
  oauthClientSecret,
  oauthScope,
  config,
  connectionType = "proxy",
  onNotification,
  defaultLoggingLevel,
  metadata = {},
}: UseConnectionOptions) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const { toast } = useToast();
  const [serverCapabilities, setServerCapabilities] =
    useState<ServerCapabilities | null>(null);
  const [mcpClient, setMcpClient] = useState<Client | null>(null);
  const [clientTransport, setClientTransport] = useState<Transport | null>(
    null,
  );
  const [requestHistory, setRequestHistory] = useState<
    { request: string; response?: string }[]
  >([]);
  const [mcpSessionId, setMcpSessionId] = useState<string | null>(null);
  const [mcpProtocolVersion, setMcpProtocolVersion] = useState<string | null>(
    null,
  );
  const [serverImplementation, setServerImplementation] =
    useState<Implementation | null>(null);
  const [connectionDiagnostic, setConnectionDiagnostic] =
    useState<ConnectionDiagnostic | null>(null);
  const connectionAbortControllerRef = useRef<AbortController | null>(null);
  const connectingTransportRef = useRef<Transport | null>(null);
  const connectingClientRef = useRef<Client<
    Request,
    Notification,
    Result
  > | null>(null);
  const connectAttemptRef = useRef(0);

  const closeQuietly = (target: { close: () => void | Promise<void> }) => {
    Promise.resolve(target.close()).catch((error) => {
      console.warn("Failed to close pending MCP connection", error);
    });
  };

  const cancelConnectAttempt = ({
    resetStatus = true,
  }: { resetStatus?: boolean } = {}) => {
    const abortController = connectionAbortControllerRef.current;
    const connectingTransport = connectingTransportRef.current;
    const connectingClient = connectingClientRef.current;

    if (abortController || connectingTransport || connectingClient) {
      connectAttemptRef.current += 1;
    }

    connectionAbortControllerRef.current = null;
    connectingTransportRef.current = null;
    connectingClientRef.current = null;

    abortController?.abort();
    if (connectingClient) closeQuietly(connectingClient);
    if (connectingTransport) closeQuietly(connectingTransport);

    if (resetStatus) {
      setConnectionStatus("disconnected");
      setConnectionDiagnostic(null);
      setServerCapabilities(null);
      setServerImplementation(null);
    }
  };

  const clearActiveConnectAttempt = (
    abortController: AbortController,
    attemptId: number,
  ) => {
    if (
      connectionAbortControllerRef.current === abortController &&
      connectAttemptRef.current === attemptId
    ) {
      connectionAbortControllerRef.current = null;
      connectingTransportRef.current = null;
      connectingClientRef.current = null;
    }
  };

  const isActiveConnectAttempt = (
    abortController: AbortController,
    attemptId: number,
  ) =>
    connectionAbortControllerRef.current === abortController &&
    connectAttemptRef.current === attemptId &&
    !abortController.signal.aborted;

  const mergeAbortSignals = (
    ...signals: Array<AbortSignal | null | undefined>
  ): AbortSignal | undefined => {
    const activeSignals = signals.filter((signal): signal is AbortSignal =>
      Boolean(signal),
    );
    if (activeSignals.length === 0) return undefined;
    if (activeSignals.length === 1) return activeSignals[0];

    const abortController = new AbortController();
    const abort = () => abortController.abort();

    for (const signal of activeSignals) {
      if (signal.aborted) {
        abort();
        break;
      }
      signal.addEventListener("abort", abort, { once: true });
    }

    return abortController.signal;
  };

  const withConnectionAbort = (
    init: RequestInit | undefined,
    signal: AbortSignal,
  ): RequestInit => ({
    ...init,
    signal: mergeAbortSignals(init?.signal, signal),
  });

  const normalizeRequestHeaders = (
    headers?: HeadersInit,
  ): Record<string, string> => {
    const normalizedHeaders: Record<string, string> = {};
    const canonicalHeaderName = (name: string) => {
      const headerName = name.trim();
      switch (headerName.toLowerCase()) {
        case "authorization":
          return "Authorization";
        case "accept":
          return "Accept";
        case "content-type":
          return "content-type";
        default:
          return headerName;
      }
    };
    const setHeader = (name: string, value: string) => {
      const headerName = canonicalHeaderName(name);
      if (!headerName) return;
      const existingHeaderName = Object.keys(normalizedHeaders).find(
        (key) => key.toLowerCase() === headerName.toLowerCase(),
      );
      if (existingHeaderName) {
        delete normalizedHeaders[existingHeaderName];
      }
      normalizedHeaders[headerName] = value;
    };

    if (!headers) return normalizedHeaders;
    if (headers instanceof Headers) {
      headers.forEach((value, name) => setHeader(name, value));
      return normalizedHeaders;
    }
    if (Array.isArray(headers)) {
      headers.forEach(([name, value]) => setHeader(name, value));
      return normalizedHeaders;
    }

    Object.entries(headers).forEach(([name, value]) => {
      setHeader(name, value);
    });
    return normalizedHeaders;
  };

  const mergeRequestHeaders = (
    ...headersList: Array<HeadersInit | undefined>
  ): Record<string, string> =>
    headersList.reduce<Record<string, string>>(
      (mergedHeaders, currentHeaders) => ({
        ...mergedHeaders,
        ...normalizeRequestHeaders(currentHeaders),
      }),
      {},
    );

  const isAbortError = (error: unknown) =>
    error instanceof Error && error.name === "AbortError";

  useEffect(() => {
    if (!oauthClientId) {
      clearClientInformationFromSessionStorage({
        serverUrl: sseUrl,
        isPreregistered: true,
      });
      return;
    }

    const clientInformation: { client_id: string; client_secret?: string } = {
      client_id: oauthClientId,
    };

    if (oauthClientSecret) {
      clientInformation.client_secret = oauthClientSecret;
    }

    saveClientInformationToSessionStorage({
      serverUrl: sseUrl,
      clientInformation,
      isPreregistered: true,
    });
  }, [oauthClientId, oauthClientSecret, sseUrl]);

  useEffect(() => {
    if (!oauthScope) {
      clearScopeFromSessionStorage(sseUrl);
      return;
    }

    saveScopeToSessionStorage(sseUrl, oauthScope);
  }, [oauthScope, sseUrl]);

  const pushHistory = (request: object, response?: object) => {
    setRequestHistory((prev) => [
      ...prev,
      {
        request: JSON.stringify(request),
        response: response !== undefined ? JSON.stringify(response) : undefined,
      },
    ]);
  };

  const makeRequest = async <T extends AnySchema>(
    request: ClientRequest,
    schema: T,
    options?: RequestOptions & { suppressToast?: boolean },
  ): Promise<SchemaOutput<T>> => {
    if (!mcpClient) {
      throw new Error("MCP client not connected");
    }
    try {
      const abortController = new AbortController();

      // Add metadata to the request if available, but skip for tool calls
      // as they handle metadata merging separately
      const shouldAddGeneralMetadata =
        request.method !== "tools/call" && Object.keys(metadata).length > 0;
      const requestWithMetadata = shouldAddGeneralMetadata
        ? {
            ...request,
            params: {
              ...request.params,
              _meta: metadata,
            },
          }
        : request;

      // prepare MCP Client request options
      const mcpRequestOptions: RequestOptions = {
        signal: options?.signal ?? abortController.signal,
        resetTimeoutOnProgress:
          options?.resetTimeoutOnProgress ??
          resetRequestTimeoutOnProgress(config),
        timeout: options?.timeout ?? getMCPServerRequestTimeout(config),
        maxTotalTimeout:
          options?.maxTotalTimeout ??
          getMCPServerRequestMaxTotalTimeout(config),
      };

      // If progress notifications are enabled, add an onprogress hook to the MCP Client request options
      // This is required by SDK to reset the timeout on progress notifications
      if (mcpRequestOptions.resetTimeoutOnProgress) {
        mcpRequestOptions.onprogress = (params: Progress) => {
          // Add progress notification to `Server Notification` window in the UI
          if (onNotification) {
            onNotification({
              method: "notifications/progress",
              params,
            });
          }
        };
      }

      let response;
      try {
        response = await mcpClient.request(
          requestWithMetadata,
          schema,
          mcpRequestOptions,
        );

        pushHistory(requestWithMetadata, response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        pushHistory(requestWithMetadata, { error: errorMessage });
        throw error;
      }

      return response;
    } catch (e: unknown) {
      if (!options?.suppressToast) {
        const errorString = (e as Error).message ?? String(e);
        toast({
          title: "Error",
          description: errorString,
          variant: "destructive",
        });
      }
      throw e;
    }
  };

  const getProxyAuthHeaders = (): HeadersInit => {
    const { token: proxyAuthToken, header: proxyAuthTokenHeader } =
      getMCPProxyAuthToken(config);
    const headers: HeadersInit = {};
    if (proxyAuthToken) {
      headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
    }
    return headers;
  };

  const buildConnectionDiagnostic = (error: unknown): ConnectionDiagnostic =>
    explainConnectionFailure({
      error,
      connectionType,
      transportType,
      proxyAuthTokenPresent: Boolean(getMCPProxyAuthToken(config).token),
      serverUrl: sseUrl,
    });

  const checkProxyHealth = async (signal: AbortSignal) => {
    try {
      const proxyHealthUrl = new URL(`${getMCPProxyAddress(config)}/health`);
      const proxyHealthResponse = await fetch(proxyHealthUrl, {
        headers: getProxyAuthHeaders(),
        signal,
      });
      const proxyHealth = await proxyHealthResponse.json();
      if (proxyHealth?.status !== "ok") {
        throw new Error("MCP Proxy Server is not healthy");
      }
    } catch (e) {
      console.error("Couldn't connect to MCP Proxy Server", e);
      throw e;
    }
  };

  const ensureProxyAuthentication = async (
    signal: AbortSignal,
  ): Promise<boolean> => {
    const proxyConfigUrl = new URL(`${getMCPProxyAddress(config)}/config`);
    const response = await fetch(proxyConfigUrl, {
      headers: getProxyAuthHeaders(),
      signal,
    });

    if (signal.aborted) {
      return false;
    }

    if (response.status !== 401) {
      return true;
    }

    if (signal.aborted) {
      return false;
    }

    setConnectionDiagnostic(
      buildConnectionDiagnostic(new Error("HTTP 401: Unauthorized")),
    );
    setConnectionStatus("error");
    toast({
      title: "需要 Proxy Session Token",
      description:
        "请使用带 MCP_PROXY_AUTH_TOKEN 的调试器地址打开页面，或在 Configuration 中填写 proxy session token。",
      variant: "destructive",
    });
    return false;
  };

  const isProxyAuthError = (error: unknown): boolean => {
    return (
      error instanceof Error &&
      error.message.includes("Authentication required. Use the session token")
    );
  };

  const handleAuthError = async (error: unknown) => {
    if (isConnectionAuthError(error)) {
      let scope = oauthScope?.trim();
      const fetchFn =
        connectionType === "proxy" ? createProxyFetch(config) : undefined;

      if (!scope) {
        // Only discover resource metadata when we need to discover scopes
        let resourceMetadata;
        try {
          resourceMetadata = await discoverOAuthProtectedResourceMetadata(
            new URL("/", sseUrl),
            {},
            fetchFn,
          );
        } catch {
          // Resource metadata is optional, continue without it
        }
        scope = await discoverScopes(sseUrl, resourceMetadata, fetchFn);
      }

      saveScopeToSessionStorage(sseUrl, scope);
      const serverAuthProvider = new InspectorOAuthClientProvider(sseUrl);

      try {
        const result = await auth(serverAuthProvider, {
          serverUrl: sseUrl,
          scope,
          ...(fetchFn && { fetchFn }),
        });
        return result === "AUTHORIZED";
      } catch (authError) {
        // Show user-friendly error message for OAuth failures
        toast({
          title: "OAuth Authentication Failed",
          description:
            authError instanceof Error ? authError.message : String(authError),
          variant: "destructive",
        });
        return false;
      }
    }

    return false;
  };

  const captureResponseHeaders = (response: Response): void => {
    const sessionId = response.headers.get("mcp-session-id");
    const protocolVersion = response.headers.get("mcp-protocol-version");
    if (sessionId && sessionId !== mcpSessionId) {
      setMcpSessionId(sessionId);
    }
    if (protocolVersion && protocolVersion !== mcpProtocolVersion) {
      setMcpProtocolVersion(protocolVersion);
    }
  };

  const connect = async (_e?: unknown, retryCount: number = 0) => {
    const isRetry = retryCount > 0;
    const abortController = isRetry
      ? connectionAbortControllerRef.current
      : new AbortController();

    if (!abortController) {
      return;
    }

    const attemptId = isRetry
      ? connectAttemptRef.current
      : connectAttemptRef.current + 1;

    if (!isRetry) {
      cancelConnectAttempt({ resetStatus: false });
      connectAttemptRef.current = attemptId;
      connectionAbortControllerRef.current = abortController;
      connectingTransportRef.current = null;
      connectingClientRef.current = null;
      setConnectionStatus("connecting");
      setConnectionDiagnostic(null);
      setServerCapabilities(null);
      setServerImplementation(null);
    }

    const abortSignal = abortController.signal;
    let hasUserAuthorizationHeader = false;
    let hasOAuthContext = Boolean(
      oauthClientId?.trim() || oauthClientSecret?.trim() || oauthScope?.trim(),
    );
    const hasOAuthChallenge = (response: Response) => {
      const wwwAuthenticate = response.headers.get("www-authenticate");
      if (!wwwAuthenticate) return false;

      const challenge = wwwAuthenticate.toLowerCase();
      return (
        challenge.includes("bearer") &&
        (challenge.includes("resource_metadata") ||
          challenge.includes("authorization_uri"))
      );
    };
    const shouldStopAfterUnauthorized = (response: Response) => {
      if (response.status !== 401) return false;
      if (hasUserAuthorizationHeader) return true;
      return !hasOAuthContext && !hasOAuthChallenge(response);
    };
    const fetchWithConnectionAbort = async (
      url: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const response = await fetch(url, withConnectionAbort(init, abortSignal));
      if (shouldStopAfterUnauthorized(response)) {
        await response.body?.cancel();
        throw new Error(`HTTP 401: Unauthorized at ${String(url)}`);
      }
      return response;
    };
    const fetchWithResponseHeaderCapture = async (
      url: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const response = await fetchWithConnectionAbort(url, init);
      if (isActiveConnectAttempt(abortController, attemptId)) {
        captureResponseHeaders(response);
      }
      return response;
    };

    // 仅声明 tools 调试所需的最小客户端能力。
    const clientCapabilities = {
      capabilities: {},
    };

    const client = new Client<Request, Notification, Result>(
      CLIENT_IDENTITY,
      clientCapabilities,
    );
    connectingClientRef.current = client;

    if (!isActiveConnectAttempt(abortController, attemptId)) return;

    // Only check proxy health for proxy connections
    if (connectionType === "proxy") {
      try {
        await checkProxyHealth(abortSignal);
        if (!isActiveConnectAttempt(abortController, attemptId)) return;

        const proxyAuthReady = await ensureProxyAuthentication(abortSignal);
        if (!isActiveConnectAttempt(abortController, attemptId)) return;
        if (!proxyAuthReady) {
          clearActiveConnectAttempt(abortController, attemptId);
          return;
        }
      } catch (error) {
        if (abortSignal.aborted || isAbortError(error)) {
          clearActiveConnectAttempt(abortController, attemptId);
          return;
        }
        if (!isActiveConnectAttempt(abortController, attemptId)) return;
        setConnectionDiagnostic(buildConnectionDiagnostic(error));
        setConnectionStatus("error-connecting-to-proxy");
        clearActiveConnectAttempt(abortController, attemptId);
        return;
      }
    }

    let lastRequest = "";
    try {
      // Inject auth manually instead of using SSEClientTransport, because we're
      // proxying through the inspector server first.
      const headers: HeadersInit = {};

      // Create an auth provider with the current server URL
      const serverAuthProvider = new InspectorOAuthClientProvider(sseUrl);

      // Use custom headers (migration is handled in App.tsx)
      let finalHeaders: CustomHeaders = customHeaders || [];

      const isEmptyAuthHeader = (header: CustomHeaders[number]) =>
        header.name.trim().toLowerCase() === "authorization" &&
        header.value.trim().toLowerCase() === "bearer";

      // Check for empty Authorization headers and show validation error
      const hasEmptyAuthHeader = finalHeaders.some(
        (header) => header.enabled && isEmptyAuthHeader(header),
      );

      hasUserAuthorizationHeader = finalHeaders.some(
        (header) =>
          header.enabled &&
          header.name.trim().toLowerCase() === "authorization",
      );

      if (hasEmptyAuthHeader) {
        toast({
          title: "Invalid Authorization Header",
          description:
            "Authorization header is enabled but empty. Please add a token or disable the header.",
          variant: "destructive",
        });
      }

      const needsOAuthToken = !hasUserAuthorizationHeader;

      if (needsOAuthToken) {
        const oauthToken = (await serverAuthProvider.tokens())?.access_token;
        if (!isActiveConnectAttempt(abortController, attemptId)) return;
        if (oauthToken) {
          hasOAuthContext = true;
          // Add the OAuth token
          finalHeaders = [
            // Remove any existing Authorization headers with empty tokens
            ...finalHeaders.filter((header) => !isEmptyAuthHeader(header)),
            {
              name: "Authorization",
              value: `Bearer ${oauthToken}`,
              enabled: true,
            },
          ];
        }
      }

      // Process all enabled custom headers
      const customHeaderNames: string[] = [];
      finalHeaders.forEach((header) => {
        if (header.enabled && header.name.trim() && header.value.trim()) {
          const headerName = header.name.trim();
          const headerValue = header.value.trim();

          headers[headerName] = headerValue;

          // Track custom header names for server processing
          if (headerName.toLowerCase() !== "authorization") {
            customHeaderNames.push(headerName);
          }
        }
      });

      // Add custom header names as a special request header for server processing
      if (customHeaderNames.length > 0) {
        headers["x-custom-auth-headers"] = JSON.stringify(customHeaderNames);
      }

      // Create appropriate transport
      let transportOptions:
        | StreamableHTTPClientTransportOptions
        | SSEClientTransportOptions;

      let serverUrl: URL;

      // Determine connection URL based on the connection type
      if (connectionType === "direct" && transportType !== "stdio") {
        // Direct connection - use the provided URL directly (not available for STDIO)
        serverUrl = new URL(sseUrl);

        const requestHeaders = mergeRequestHeaders(
          headers,
          mcpSessionId ? { "mcp-session-id": mcpSessionId } : undefined,
        );
        switch (transportType) {
          case "sse":
            requestHeaders["Accept"] = "text/event-stream";
            requestHeaders["content-type"] = "application/json";
            transportOptions = {
              authProvider: serverAuthProvider,
              fetch: fetchWithResponseHeaderCapture,
              requestInit: {
                headers: requestHeaders,
                signal: abortSignal,
              },
            };
            break;

          case "streamable-http":
            transportOptions = {
              authProvider: serverAuthProvider,
              fetch: fetchWithResponseHeaderCapture,
              requestInit: {
                headers: requestHeaders,
                signal: abortSignal,
              },
              // TODO these should be configurable...
              reconnectionOptions: {
                maxReconnectionDelay: 30000,
                initialReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1.5,
                maxRetries: 2,
              },
            };
            break;
        }
      } else {
        // Proxy connection (default behavior)
        // Add proxy authentication headers for proxy connections only
        const proxyHeaders = getProxyAuthHeaders();

        let mcpProxyServerUrl;
        switch (transportType) {
          case "stdio": {
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/stdio`);
            mcpProxyServerUrl.searchParams.append("command", command);
            mcpProxyServerUrl.searchParams.append("args", args);
            mcpProxyServerUrl.searchParams.append("env", JSON.stringify(env));

            const proxyFullAddress = config.MCP_PROXY_FULL_ADDRESS
              .value as string;
            if (proxyFullAddress) {
              mcpProxyServerUrl.searchParams.append(
                "proxyFullAddress",
                proxyFullAddress,
              );
            }
            transportOptions = {
              authProvider: serverAuthProvider,
              eventSourceInit: {
                fetch: fetchWithConnectionAbort,
              },
              requestInit: {
                headers: mergeRequestHeaders(headers, proxyHeaders),
                signal: abortSignal,
              },
            };
            break;
          }

          case "sse": {
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/sse`);
            mcpProxyServerUrl.searchParams.append("url", sseUrl);

            const proxyFullAddressSSE = config.MCP_PROXY_FULL_ADDRESS
              .value as string;
            if (proxyFullAddressSSE) {
              mcpProxyServerUrl.searchParams.append(
                "proxyFullAddress",
                proxyFullAddressSSE,
              );
            }
            transportOptions = {
              authProvider: serverAuthProvider,
              eventSourceInit: {
                fetch: fetchWithConnectionAbort,
              },
              requestInit: {
                headers: mergeRequestHeaders(headers, proxyHeaders),
                signal: abortSignal,
              },
            };
            break;
          }

          case "streamable-http":
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/mcp`);
            mcpProxyServerUrl.searchParams.append("url", sseUrl);
            transportOptions = {
              authProvider: serverAuthProvider,
              fetch: fetchWithConnectionAbort,
              requestInit: {
                headers: mergeRequestHeaders(headers, proxyHeaders),
                signal: abortSignal,
              },
              // TODO these should be configurable...
              reconnectionOptions: {
                maxReconnectionDelay: 30000,
                initialReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1.5,
                maxRetries: 2,
              },
            };
            break;
        }
        serverUrl = mcpProxyServerUrl as URL;
        serverUrl.searchParams.append("transportType", transportType);
      }

      if (!isActiveConnectAttempt(abortController, attemptId)) return;

      if (onNotification) {
        [
          CancelledNotificationSchema,
          LoggingMessageNotificationSchema,
          ResourceUpdatedNotificationSchema,
          ResourceListChangedNotificationSchema,
          ToolListChangedNotificationSchema,
          PromptListChangedNotificationSchema,
        ].forEach((notificationSchema) => {
          client.setNotificationHandler(notificationSchema, onNotification);
        });

        client.fallbackNotificationHandler = (
          notification: Notification,
        ): Promise<void> => {
          onNotification(notification);
          return Promise.resolve();
        };
      }

      let capabilities: ServerCapabilities | undefined;
      let transport: Transport | null = null;
      try {
        transport =
          transportType === "streamable-http"
            ? new StreamableHTTPClientTransport(serverUrl, {
                sessionId: undefined,
                ...transportOptions,
              })
            : new SSEClientTransport(serverUrl, transportOptions);

        connectingTransportRef.current = transport;
        if (!isActiveConnectAttempt(abortController, attemptId)) return;

        await client.connect(transport);
        if (!isActiveConnectAttempt(abortController, attemptId)) return;

        const protocolOnMessage = transport.onmessage;
        if (protocolOnMessage) {
          transport.onmessage = (message) => {
            const resolvedMessage = resolveRefsInMessage(message);
            protocolOnMessage(resolvedMessage);
          };
        }

        setClientTransport(transport);

        capabilities = client.getServerCapabilities();
        const serverInfo = client.getServerVersion();
        setServerImplementation(serverInfo || null);
        const initializeRequest = {
          method: "initialize",
        };
        pushHistory(initializeRequest, {
          capabilities,
          serverInfo: client.getServerVersion(),
          instructions: client.getInstructions(),
        });
      } catch (error) {
        console.error(
          connectionType === "direct"
            ? `Failed to connect directly to MCP Server at: ${serverUrl}:`
            : `Failed to connect to MCP Server via the proxy: ${serverUrl}:`,
          error,
        );

        if (
          abortSignal.aborted ||
          isAbortError(error) ||
          !isActiveConnectAttempt(abortController, attemptId)
        ) {
          if (transport) closeQuietly(transport);
          clearActiveConnectAttempt(abortController, attemptId);
          return;
        }

        // Check if it's a proxy auth error
        if (isProxyAuthError(error)) {
          const diagnostic = buildConnectionDiagnostic(error);
          setConnectionDiagnostic(diagnostic);
          toast({
            title: diagnostic.title,
            description: diagnostic.suggestion,
            variant: "destructive",
          });
          setConnectionStatus("error");
          clearActiveConnectAttempt(abortController, attemptId);
          return;
        }

        const shouldRetry = await handleAuthError(error);
        if (!isActiveConnectAttempt(abortController, attemptId)) return;
        if (shouldRetry) {
          return connect(undefined, retryCount + 1);
        }
        if (isConnectionAuthError(error)) {
          // OAuth can redirect the page. If it does not, leave the UI in a safe idle state.
          setConnectionStatus("disconnected");
          clearActiveConnectAttempt(abortController, attemptId);
          return;
        }
        throw error;
      }

      if (!isActiveConnectAttempt(abortController, attemptId)) return;
      setServerCapabilities(capabilities ?? null);

      if (capabilities?.logging && defaultLoggingLevel) {
        lastRequest = "logging/setLevel";
        await client.setLoggingLevel(defaultLoggingLevel);
        if (!isActiveConnectAttempt(abortController, attemptId)) return;
        pushHistory(
          {
            method: "logging/setLevel",
            params: {
              level: defaultLoggingLevel,
            },
          },
          {},
        );
        lastRequest = "";
      }

      if (!isActiveConnectAttempt(abortController, attemptId)) return;
      setMcpClient(client);
      setConnectionDiagnostic(null);
      setConnectionStatus("connected");
      clearActiveConnectAttempt(abortController, attemptId);
    } catch (e) {
      if (
        abortSignal.aborted ||
        isAbortError(e) ||
        !isActiveConnectAttempt(abortController, attemptId)
      ) {
        clearActiveConnectAttempt(abortController, attemptId);
        return;
      }

      if (
        lastRequest === "logging/setLevel" &&
        e instanceof McpError &&
        e.code === ErrorCode.MethodNotFound
      ) {
        toast({
          title: "Error",
          description: `Server declares logging capability but doesn't implement method: "${lastRequest}"`,
          variant: "destructive",
        });
      } else {
        const diagnostic = buildConnectionDiagnostic(e);
        setConnectionDiagnostic(diagnostic);
        toast({
          title: diagnostic.title,
          description: diagnostic.suggestion,
          variant: "destructive",
        });
      }
      console.error(e);
      setConnectionStatus("error");
      clearActiveConnectAttempt(abortController, attemptId);
    }
  };

  const disconnect = async () => {
    cancelConnectAttempt({ resetStatus: false });

    if (transportType === "streamable-http" && clientTransport) {
      await (
        clientTransport as StreamableHTTPClientTransport
      ).terminateSession();
    }
    await mcpClient?.close();
    const authProvider = new InspectorOAuthClientProvider(sseUrl);
    authProvider.clear();
    setMcpClient(null);
    setClientTransport(null);
    setConnectionStatus("disconnected");
    setConnectionDiagnostic(null);
    setServerCapabilities(null);
    setServerImplementation(null);
    setMcpSessionId(null);
    setMcpProtocolVersion(null);
  };

  return {
    connectionStatus,
    serverCapabilities,
    serverImplementation,
    connectionDiagnostic,
    mcpClient,
    requestHistory,
    makeRequest,
    connect,
    cancelConnectAttempt,
    disconnect,
  };
}
