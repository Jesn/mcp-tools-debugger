import { renderHook, act } from "@testing-library/react";
import { useConnection } from "../useConnection";
import { z } from "zod/v3";
import {
  ClientRequest,
  JSONRPCMessage,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  DEFAULT_INSPECTOR_CONFIG,
  MCP_PROXY_TRANSPORT_ERROR_CODE,
} from "../../constants";
import {
  SSEClientTransportOptions,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { discoverScopes } from "../../auth";
import { CustomHeaders } from "../../types/customHeaders";

// Mock fetch
global.fetch = jest.fn().mockResolvedValue({
  json: () => Promise.resolve({ status: "ok" }),
  headers: {
    get: jest.fn().mockReturnValue(null),
  },
});

// Mock the SDK dependencies
const mockRequest = jest.fn().mockResolvedValue({ test: "response" });
const mockClient = {
  request: mockRequest,
  notification: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn(),
  getServerCapabilities: jest.fn(),
  getServerVersion: jest.fn(),
  getInstructions: jest.fn(),
  setNotificationHandler: jest.fn(),
  setRequestHandler: jest.fn(),
};

// Mock transport instances
const mockSSETransport: {
  start: jest.Mock;
  url: URL | undefined;
  options: SSEClientTransportOptions | undefined;
  onmessage?: (message: JSONRPCMessage) => void;
} = {
  start: jest.fn(),
  url: undefined,
  options: undefined,
  onmessage: undefined,
};

const mockStreamableHTTPTransport: {
  start: jest.Mock;
  url: URL | undefined;
  options: SSEClientTransportOptions | undefined;
} = {
  start: jest.fn(),
  url: undefined,
  options: undefined,
};

jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => mockClient),
}));

jest.mock("@modelcontextprotocol/sdk/client/sse.js", () => {
  // Minimal mock class that supports instanceof checks
  class SseError extends Error {
    code: number;
    event: ErrorEvent;
    constructor(code: number, message: string, event: ErrorEvent) {
      super(message);
      this.code = code;
      this.event = event;
    }
  }

  return {
    SSEClientTransport: jest.fn((url, options) => {
      mockSSETransport.url = url;
      mockSSETransport.options = options;
      return mockSSETransport;
    }),
    SseError,
  };
});

jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class StreamableHTTPError extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(`Streamable HTTP error: ${message}`);
      this.code = code;
    }
  }

  return {
    StreamableHTTPError,
    StreamableHTTPClientTransport: jest.fn((url, options) => {
      mockStreamableHTTPTransport.url = url;
      mockStreamableHTTPTransport.options = options;
      return mockStreamableHTTPTransport;
    }),
  };
});

jest.mock("@modelcontextprotocol/sdk/client/auth.js", () => {
  class UnauthorizedError extends Error {
    constructor(message?: string) {
      super(message ?? "Unauthorized");
      this.name = "UnauthorizedError";
    }
  }

  return {
    UnauthorizedError,
    auth: jest.fn().mockResolvedValue("AUTHORIZED"),
  };
});

// Mock the toast hook
const mockToast = jest.fn();
jest.mock("@/lib/hooks/useToast", () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}));

// Mock the auth provider
jest.mock("../../auth", () => ({
  InspectorOAuthClientProvider: jest.fn().mockImplementation(() => ({
    tokens: jest.fn().mockResolvedValue({ access_token: "mock-token" }),
    redirectUrl: "http://localhost:3000/oauth/callback",
  })),
  clearClientInformationFromSessionStorage: jest.fn(),
  saveClientInformationToSessionStorage: jest.fn(),
  saveScopeToSessionStorage: jest.fn(),
  clearScopeFromSessionStorage: jest.fn(),
  discoverScopes: jest.fn(),
}));

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockDiscoverScopes = discoverScopes as jest.MockedFunction<
  typeof discoverScopes
>;

describe("useConnection", () => {
  const defaultProps: Parameters<typeof useConnection>[0] = {
    transportType: "sse" as const,
    command: "",
    args: "",
    sseUrl: "http://localhost:8080",
    env: {},
    config: DEFAULT_INSPECTOR_CONFIG,
  };

  describe("Request Configuration", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test("uses the default config values in makeRequest", async () => {
      const { result } = renderHook(() => useConnection(defaultProps));

      // Connect the client
      await act(async () => {
        await result.current.connect();
      });

      // Wait for state update
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const mockRequest: ClientRequest = {
        method: "ping",
        params: {},
      };

      const mockSchema = z.object({
        test: z.string(),
      });

      const mockSchemaAny: AnySchema = mockSchema as unknown as AnySchema;

      await act(async () => {
        await result.current.makeRequest(mockRequest, mockSchemaAny);
      });

      expect(mockClient.request).toHaveBeenCalledWith(
        mockRequest,
        mockSchema,
        expect.objectContaining({
          timeout: DEFAULT_INSPECTOR_CONFIG.MCP_SERVER_REQUEST_TIMEOUT.value,
          maxTotalTimeout:
            DEFAULT_INSPECTOR_CONFIG.MCP_REQUEST_MAX_TOTAL_TIMEOUT.value,
          resetTimeoutOnProgress:
            DEFAULT_INSPECTOR_CONFIG.MCP_REQUEST_TIMEOUT_RESET_ON_PROGRESS
              .value,
        }),
      );
    });

    test("overrides the default config values when passed in options in makeRequest", async () => {
      const { result } = renderHook(() => useConnection(defaultProps));

      // Connect the client
      await act(async () => {
        await result.current.connect();
      });

      // Wait for state update
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const mockRequest: ClientRequest = {
        method: "ping",
        params: {},
      };

      const mockSchema = z.object({
        test: z.string(),
      });

      const mockSchemaAny: AnySchema = mockSchema as unknown as AnySchema;

      await act(async () => {
        await result.current.makeRequest(mockRequest, mockSchemaAny, {
          timeout: 1000,
          maxTotalTimeout: 2000,
          resetTimeoutOnProgress: false,
        });
      });

      expect(mockClient.request).toHaveBeenCalledWith(
        mockRequest,
        mockSchema,
        expect.objectContaining({
          timeout: 1000,
          maxTotalTimeout: 2000,
          resetTimeoutOnProgress: false,
        }),
      );
    });
  });

  test("throws error when mcpClient is not connected", async () => {
    const { result } = renderHook(() => {
      const { makeRequest } = useConnection(defaultProps) as unknown as {
        makeRequest: (
          request: ClientRequest,
          schema: AnySchema,
        ) => Promise<unknown>;
      };
      return { makeRequest };
    });

    const mockRequest: ClientRequest = {
      method: "ping",
      params: {},
    };

    const mockSchema = z.object({
      test: z.string(),
    });

    const mockSchemaAny: AnySchema = mockSchema as unknown as AnySchema;

    await expect(
      result.current.makeRequest(mockRequest, mockSchemaAny),
    ).rejects.toThrow("MCP client not connected");
  });

  describe("Ref Resolution", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test("resolves $ref references in requestedSchema properties before validation", async () => {
      const mockProtocolOnMessage = jest.fn();

      mockSSETransport.onmessage = mockProtocolOnMessage;

      const { result } = renderHook(() => useConnection(defaultProps));

      await act(async () => {
        await result.current.connect();
      });

      const mockRequestWithRef: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "elicitation/create",
        params: {
          message: "Please provide your information",
          requestedSchema: {
            type: "object",
            properties: {
              source: {
                type: "string",
                minLength: 1,
                title: "A Connectable Node",
              },
              target: {
                $ref: "#/properties/source",
              },
            },
          },
        },
      };

      await act(async () => {
        mockSSETransport.onmessage!(mockRequestWithRef);
      });

      expect(mockProtocolOnMessage).toHaveBeenCalledTimes(1);

      const message = mockProtocolOnMessage.mock.calls[0][0];
      expect(message.params.requestedSchema.properties.target).toEqual({
        type: "string",
        minLength: 1,
        title: "A Connectable Node",
      });
    });

    test("resolves $ref references to $defs in requestedSchema", async () => {
      const mockProtocolOnMessage = jest.fn();

      mockSSETransport.onmessage = mockProtocolOnMessage;

      const { result } = renderHook(() => useConnection(defaultProps));

      await act(async () => {
        await result.current.connect();
      });

      const mockRequestWithDefs: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "elicitation/create",
        params: {
          message: "Please provide your information",
          requestedSchema: {
            type: "object",
            properties: {
              user: {
                $ref: "#/$defs/UserInput",
              },
            },
            $defs: {
              UserInput: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    title: "Name",
                  },
                  age: {
                    type: "integer",
                    title: "Age",
                    minimum: 0,
                  },
                },
                required: ["name"],
              },
            },
          },
        },
      };

      await act(async () => {
        mockSSETransport.onmessage!(mockRequestWithDefs);
      });

      expect(mockProtocolOnMessage).toHaveBeenCalledTimes(1);

      const message = mockProtocolOnMessage.mock.calls[0][0];
      // The $ref should be resolved to the actual UserInput definition
      expect(message.params.requestedSchema.properties.user).toEqual({
        type: "object",
        properties: {
          name: {
            type: "string",
            title: "Name",
          },
          age: {
            type: "integer",
            title: "Age",
            minimum: 0,
          },
        },
        required: ["name"],
      });
    });
  });

  describe("URL Port Handling", () => {
    const SSEClientTransport = jest.requireMock(
      "@modelcontextprotocol/sdk/client/sse.js",
    ).SSEClientTransport;
    const StreamableHTTPClientTransport = jest.requireMock(
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
    ).StreamableHTTPClientTransport;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test("preserves HTTPS port number when connecting", async () => {
      const props = {
        ...defaultProps,
        sseUrl: "https://example.com:8443/api",
        transportType: "sse" as const,
      };

      const { result } = renderHook(() => useConnection(props));

      await act(async () => {
        await result.current.connect();
      });

      const call = SSEClientTransport.mock.calls[0][0];
      expect(call.toString()).toContain(
        "url=https%3A%2F%2Fexample.com%3A8443%2Fapi",
      );
    });

    test("preserves HTTP port number when connecting", async () => {
      const props = {
        ...defaultProps,
        sseUrl: "http://localhost:3000/api",
        transportType: "sse" as const,
      };

      const { result } = renderHook(() => useConnection(props));

      await act(async () => {
        await result.current.connect();
      });

      const call = SSEClientTransport.mock.calls[0][0];
      expect(call.toString()).toContain(
        "url=http%3A%2F%2Flocalhost%3A3000%2Fapi",
      );
    });

    test("uses default port for HTTPS when not specified", async () => {
      const props = {
        ...defaultProps,
        sseUrl: "https://example.com/api",
        transportType: "sse" as const,
      };

      const { result } = renderHook(() => useConnection(props));

      await act(async () => {
        await result.current.connect();
      });

      const call = SSEClientTransport.mock.calls[0][0];
      expect(call.toString()).toContain("url=https%3A%2F%2Fexample.com%2Fapi");
      expect(call.toString()).not.toContain("%3A443");
    });

    test("preserves port number in streamable-http transport", async () => {
      const props = {
        ...defaultProps,
        sseUrl: "https://example.com:8443/api",
        transportType: "streamable-http" as const,
      };

      const { result } = renderHook(() => useConnection(props));

      await act(async () => {
        await result.current.connect();
      });

      const call = StreamableHTTPClientTransport.mock.calls[0][0];
      expect(call.toString()).toContain(
        "url=https%3A%2F%2Fexample.com%3A8443%2Fapi",
      );
    });
  });

  describe("Proxy Authentication Headers", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Reset the mock transport objects
      mockSSETransport.url = undefined;
      mockSSETransport.options = undefined;
      mockStreamableHTTPTransport.url = undefined;
      mockStreamableHTTPTransport.options = undefined;
    });

    test("sends X-MCP-Proxy-Auth header when proxy auth token is configured for proxy connectionType", async () => {
      const propsWithProxyAuth = {
        ...defaultProps,
        connectionType: "proxy" as const,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_AUTH_TOKEN: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
            value: "test-proxy-token",
          },
        },
      };

      const { result } = renderHook(() => useConnection(propsWithProxyAuth));

      await act(async () => {
        await result.current.connect();
      });

      // Check that the transport was created with the correct headers
      expect(mockSSETransport.options).toBeDefined();
      expect(mockSSETransport.options?.requestInit).toBeDefined();

      expect(mockSSETransport.options?.requestInit?.headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
      expect(mockSSETransport?.options?.eventSourceInit?.fetch).toBeDefined();

      // Verify the fetch function preserves the SDK-provided request init.
      const mockFetch = mockSSETransport.options?.eventSourceInit?.fetch;
      const testUrl = "http://test.com";
      await mockFetch?.(testUrl, {
        headers: {
          Accept: "text/event-stream",
          "X-MCP-Proxy-Auth": "Bearer test-proxy-token",
        },
        cache: "no-store",
        mode: "cors",
        signal: new AbortController().signal,
        redirect: "follow",
        credentials: "include",
      });

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const [healthCheckCall, configCheckCall, transportFetchCall] = (
        global.fetch as jest.Mock
      ).mock.calls;
      expect(healthCheckCall[0].pathname).toBe("/health");
      expect(healthCheckCall[1].headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
      expect(configCheckCall[0].pathname).toBe("/config");
      expect(configCheckCall[1].headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
      expect(transportFetchCall[0]).toBe(testUrl);
      expect(transportFetchCall[1].headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
    });

    test("does NOT send X-MCP-Proxy-Auth header when proxy auth token is configured for direct connectionType", async () => {
      const propsWithProxyAuth = {
        ...defaultProps,
        connectionType: "direct" as const,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_AUTH_TOKEN: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
            value: "test-proxy-token",
          },
        },
      };

      const { result } = renderHook(() => useConnection(propsWithProxyAuth));

      await act(async () => {
        await result.current.connect();
      });

      // Check that the transport was created with the correct headers
      expect(mockSSETransport.options).toBeDefined();
      expect(mockSSETransport.options?.requestInit).toBeDefined();

      // Verify that X-MCP-Proxy-Auth header is NOT present for direct connections
      expect(mockSSETransport.options?.requestInit?.headers).not.toHaveProperty(
        "X-MCP-Proxy-Auth",
      );
      expect(mockSSETransport?.options?.fetch).toBeDefined();

      // Verify the fetch function does NOT include the proxy auth header
      const mockFetch = mockSSETransport.options?.fetch;
      const testUrl = "http://test.com";
      await mockFetch?.(testUrl, {
        headers: {
          Accept: "text/event-stream",
        },
        cache: "no-store",
        mode: "cors",
        signal: new AbortController().signal,
        redirect: "follow",
        credentials: "include",
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(testUrl);
      expect(
        (global.fetch as jest.Mock).mock.calls[0][1].headers,
      ).not.toHaveProperty("X-MCP-Proxy-Auth");
    });

    test("does NOT send Authorization header for proxy auth", async () => {
      const propsWithProxyAuth = {
        ...defaultProps,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          proxyAuthToken: "test-proxy-token",
        },
      };

      const { result } = renderHook(() => useConnection(propsWithProxyAuth));

      await act(async () => {
        await result.current.connect();
      });

      // Check that Authorization header is NOT used for proxy auth
      expect(mockSSETransport.options?.requestInit?.headers).not.toHaveProperty(
        "Authorization",
        "Bearer test-proxy-token",
      );
    });

    test("preserves server Authorization header when proxy auth is configured", async () => {
      const customHeaders: CustomHeaders = [
        {
          name: "Authorization",
          value: "Bearer server-auth-token",
          enabled: true,
        },
      ];

      const propsWithBothAuth = {
        ...defaultProps,
        customHeaders,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_AUTH_TOKEN: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
            value: "test-proxy-token",
          },
        },
      };

      const { result } = renderHook(() => useConnection(propsWithBothAuth));

      await act(async () => {
        await result.current.connect();
      });

      // Check that both headers are present and distinct
      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty(
        "Authorization",
        "Bearer server-auth-token",
      );
      expect(headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
    });

    test("sends X-MCP-Proxy-Auth in health check requests", async () => {
      const fetchMock = global.fetch as jest.Mock;
      fetchMock.mockClear();

      const propsWithProxyAuth = {
        ...defaultProps,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_AUTH_TOKEN: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
            value: "test-proxy-token",
          },
        },
      };

      const { result } = renderHook(() => useConnection(propsWithProxyAuth));

      await act(async () => {
        await result.current.connect();
      });

      // Find the health check call
      const healthCheckCall = fetchMock.mock.calls.find(
        (call) => call[0].pathname === "/health",
      );

      expect(healthCheckCall).toBeDefined();
      expect(healthCheckCall[1].headers).toHaveProperty(
        "X-MCP-Proxy-Auth",
        "Bearer test-proxy-token",
      );
    });

    test("stops before MCP OAuth when proxy requires auth and token is missing", async () => {
      const fetchMock = global.fetch as jest.Mock;
      fetchMock.mockClear();
      fetchMock
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: "ok" }),
          headers: {
            get: jest.fn().mockReturnValue(null),
          },
        })
        .mockResolvedValueOnce({
          status: 401,
          json: () =>
            Promise.resolve({
              error: "Unauthorized",
              message: "Authentication required.",
            }),
          headers: {
            get: jest.fn().mockReturnValue(null),
          },
        });

      const { result } = renderHook(() =>
        useConnection({
          ...defaultProps,
          connectionType: "proxy",
          config: {
            ...DEFAULT_INSPECTOR_CONFIG,
            MCP_PROXY_AUTH_TOKEN: {
              ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
              value: "",
            },
          },
        }),
      );

      await act(async () => {
        await result.current.connect();
      });

      expect(mockSSETransport.url).toBeUndefined();
      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(mockAuth).not.toHaveBeenCalled();
      expect(result.current.connectionStatus).toBe("error");
      expect(result.current.connectionDiagnostic).toEqual(
        expect.objectContaining({
          code: "proxy-unauthorized",
          title: "Proxy Session Token 无效",
        }),
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "需要 Proxy Session Token",
        }),
      );
    });

    test("records a diagnostic when direct browser connection is blocked by CORS", async () => {
      mockClient.connect.mockRejectedValueOnce(
        new Error(
          "Access to fetch at 'https://example.com/sse' from origin 'http://localhost:6274' has been blocked by CORS policy",
        ),
      );

      const { result } = renderHook(() =>
        useConnection({
          ...defaultProps,
          connectionType: "direct",
          sseUrl: "https://example.com/sse",
        }),
      );

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.connectionStatus).toBe("error");
      expect(result.current.connectionDiagnostic).toEqual(
        expect.objectContaining({
          code: "cors-blocked",
          title: "浏览器 CORS 拦截",
        }),
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "浏览器 CORS 拦截",
        }),
      );
    });

    test("works correctly with streamable-http transport", async () => {
      const propsWithStreamableHttp = {
        ...defaultProps,
        transportType: "streamable-http" as const,
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_AUTH_TOKEN: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_AUTH_TOKEN,
            value: "test-proxy-token",
          },
        },
      };

      const { result } = renderHook(() =>
        useConnection(propsWithStreamableHttp),
      );

      await act(async () => {
        await result.current.connect();
      });

      // Check that the streamable HTTP transport was created with the correct headers
      expect(mockStreamableHTTPTransport.options).toBeDefined();
      expect(
        mockStreamableHTTPTransport.options?.requestInit?.headers,
      ).toHaveProperty("X-MCP-Proxy-Auth", "Bearer test-proxy-token");
    });

    test("stops streamable-http after a plain 401 when Authorization is user-managed", async () => {
      const fetchMock = global.fetch as jest.Mock;
      const cancelBody = jest.fn();
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce({
        status: 401,
        headers: {
          get: jest.fn().mockReturnValue(null),
        },
        body: {
          cancel: cancelBody,
        },
      });

      const { result } = renderHook(() =>
        useConnection({
          ...defaultProps,
          connectionType: "direct",
          transportType: "streamable-http",
          customHeaders: [
            {
              name: "Authorization",
              value: "Bearer invalid-token",
              enabled: true,
            },
          ],
        }),
      );

      await act(async () => {
        await result.current.connect();
      });

      const fetchFn = (
        mockStreamableHTTPTransport.options as { fetch?: typeof fetch }
      ).fetch;
      expect(fetchFn).toBeDefined();
      await expect(fetchFn!("http://127.0.0.1:3302/mcp", {})).rejects.toThrow(
        "HTTP 401: Unauthorized",
      );
      expect(cancelBody).toHaveBeenCalled();
      expect(mockAuth).not.toHaveBeenCalled();
    });
  });

  describe("Custom Headers", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Reset the mock transport objects
      mockSSETransport.url = undefined;
      mockSSETransport.options = undefined;
      mockStreamableHTTPTransport.url = undefined;
      mockStreamableHTTPTransport.options = undefined;
    });

    test("sends multiple custom headers correctly", async () => {
      const customHeaders: CustomHeaders = [
        { name: "Authorization", value: "Bearer token123", enabled: true },
        { name: "X-Tenant-ID", value: "acme-inc", enabled: true },
        { name: "X-Environment", value: "staging", enabled: true },
      ];

      const propsWithCustomHeaders = {
        ...defaultProps,
        customHeaders,
      };

      const { result } = renderHook(() =>
        useConnection(propsWithCustomHeaders),
      );

      await act(async () => {
        await result.current.connect();
      });

      // Check that the transport was created with the correct headers
      expect(mockSSETransport.options).toBeDefined();
      expect(mockSSETransport.options?.requestInit?.headers).toBeDefined();

      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty("Authorization", "Bearer token123");
      expect(headers).toHaveProperty("X-Tenant-ID", "acme-inc");
      expect(headers).toHaveProperty("X-Environment", "staging");
      expect(headers).toHaveProperty(
        "x-custom-auth-headers",
        JSON.stringify(["X-Tenant-ID", "X-Environment"]),
      );
    });

    test("ignores disabled custom headers", async () => {
      const customHeaders: CustomHeaders = [
        { name: "Authorization", value: "Bearer token123", enabled: true },
        { name: "X-Disabled", value: "should-not-appear", enabled: false },
        { name: "X-Enabled", value: "should-appear", enabled: true },
      ];

      const propsWithCustomHeaders = {
        ...defaultProps,
        customHeaders,
      };

      const { result } = renderHook(() =>
        useConnection(propsWithCustomHeaders),
      );

      await act(async () => {
        await result.current.connect();
      });

      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty("Authorization", "Bearer token123");
      expect(headers).toHaveProperty("X-Enabled", "should-appear");
      expect(headers).not.toHaveProperty("X-Disabled");
    });

    test("handles migrated legacy auth via custom headers", async () => {
      // Simulate what App.tsx would do - migrate legacy auth to custom headers
      const customHeaders: CustomHeaders = [
        { name: "X-Custom-Auth", value: "legacy-token", enabled: true },
      ];

      const propsWithMigratedAuth = {
        ...defaultProps,
        customHeaders,
      };

      const { result } = renderHook(() => useConnection(propsWithMigratedAuth));

      await act(async () => {
        await result.current.connect();
      });

      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty("X-Custom-Auth", "legacy-token");
      expect(headers).toHaveProperty(
        "x-custom-auth-headers",
        JSON.stringify(["X-Custom-Auth"]),
      );
    });

    test("uses OAuth token when no custom headers or legacy auth provided", async () => {
      const propsWithoutAuth = {
        ...defaultProps,
      };

      const { result } = renderHook(() => useConnection(propsWithoutAuth));

      await act(async () => {
        await result.current.connect();
      });

      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty("Authorization", "Bearer mock-token");
    });

    test("warns of enabled empty Bearer token", async () => {
      // This test prevents regression of the bug where default "Bearer " header
      // prevented OAuth token injection, causing infinite auth loops
      const customHeaders: CustomHeaders = [
        {
          name: "Authorization",
          value: "Bearer ", // Empty Bearer token placeholder
          enabled: true, // enabled
        },
      ];

      const propsWithEmptyBearer = {
        ...defaultProps,
        customHeaders,
      };

      const { result } = renderHook(() => useConnection(propsWithEmptyBearer));

      await act(async () => {
        await result.current.connect();
      });

      const headers = mockSSETransport.options?.requestInit?.headers;

      expect(headers).toHaveProperty("Authorization", "Bearer");
      // Should not have the x-custom-auth-headers since Authorization is standard
      expect(headers).not.toHaveProperty("x-custom-auth-headers");

      // Should show toast notification for empty Authorization header
      expect(mockToast).toHaveBeenCalledWith({
        title: "Invalid Authorization Header",
        description: expect.any(String),
        variant: "destructive",
      });
    });

    test("prioritizes custom headers over legacy auth", async () => {
      const customHeaders: CustomHeaders = [
        { name: "Authorization", value: "Bearer custom-token", enabled: true },
      ];

      const propsWithBothAuth = {
        ...defaultProps,
        customHeaders,
        bearerToken: "legacy-token",
        headerName: "Authorization",
      };

      const { result } = renderHook(() => useConnection(propsWithBothAuth));

      await act(async () => {
        await result.current.connect();
      });

      const headers = mockSSETransport.options?.requestInit?.headers;
      expect(headers).toHaveProperty("Authorization", "Bearer custom-token");
    });
  });

  describe("Connection URL Verification", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Reset the mock transport objects
      mockSSETransport.url = undefined;
      mockSSETransport.options = undefined;
      mockStreamableHTTPTransport.url = undefined;
      mockStreamableHTTPTransport.options = undefined;
    });

    test("uses server URL directly when connectionType is 'direct'", async () => {
      const directProps = {
        ...defaultProps,
        connectionType: "direct" as const,
      };

      const { result } = renderHook(() => useConnection(directProps));

      await act(async () => {
        await result.current.connect();
      });

      // Verify the transport was created with the direct server URL
      expect(mockSSETransport.url).toBeDefined();
      expect(mockSSETransport.url?.toString()).toBe("http://localhost:8080/");
    });

    test("uses proxy server URL when connectionType is 'proxy'", async () => {
      const proxyProps = {
        ...defaultProps,
        connectionType: "proxy" as const,
      };

      const { result } = renderHook(() => useConnection(proxyProps));

      await act(async () => {
        await result.current.connect();
      });

      // Verify the transport was created with a proxy server URL
      expect(mockSSETransport.url).toBeDefined();
      expect(mockSSETransport.url?.pathname).toBe("/sse");
      expect(mockSSETransport.url?.searchParams.get("url")).toBe(
        "http://localhost:8080",
      );
      expect(mockSSETransport.url?.searchParams.get("transportType")).toBe(
        "sse",
      );
    });
  });

  describe("OAuth Error Handling with Scope Discovery", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockAuth.mockResolvedValue("AUTHORIZED");
      mockDiscoverScopes.mockResolvedValue(undefined);
    });

    const setup401Error = () => {
      const mockErrorEvent = new ErrorEvent("error", {
        message: "Mock error event",
      });
      mockClient.connect.mockRejectedValueOnce(
        new SseError(401, "Unauthorized", mockErrorEvent),
      );
    };

    const attemptConnection = async (props = defaultProps) => {
      const { result } = renderHook(() => useConnection(props));
      await act(async () => {
        try {
          await result.current.connect();
        } catch {
          // Expected error from auth handling
        }
      });
    };

    const testCases = [
      [
        "discovers and includes scopes in auth call",
        {
          discoveredScope: "read write admin",
          oauthScope: undefined,
          expectScopeCall: true,
          expectedAuthScope: "read write admin",
          authResult: "AUTHORIZED",
        },
      ],
      [
        "handles scope discovery failure gracefully",
        {
          discoveredScope: undefined,
          oauthScope: undefined,
          expectScopeCall: true,
          expectedAuthScope: undefined,
          authResult: "AUTHORIZED",
        },
      ],
      [
        "uses manual oauthScope override instead of discovered scopes",
        {
          discoveredScope: "discovered:scope",
          oauthScope: "manual:scope",
          expectScopeCall: false,
          expectedAuthScope: "manual:scope",
          authResult: "AUTHORIZED",
        },
      ],
      [
        "triggers scope discovery when oauthScope is whitespace",
        {
          discoveredScope: "discovered:scope",
          oauthScope: "   ",
          expectScopeCall: true,
          expectedAuthScope: "discovered:scope",
          authResult: "AUTHORIZED",
        },
      ],
      [
        "handles auth failure after scope discovery",
        {
          discoveredScope: "read write",
          oauthScope: undefined,
          expectScopeCall: true,
          expectedAuthScope: "read write",
          authResult: "UNAUTHORIZED",
        },
      ],
    ] as const;

    test.each(testCases)(
      "should %s",
      async (
        _,
        {
          discoveredScope,
          oauthScope,
          expectScopeCall,
          expectedAuthScope,
          authResult = "AUTHORIZED",
        },
      ) => {
        mockDiscoverScopes.mockResolvedValue(discoveredScope);
        mockAuth.mockResolvedValue(authResult as never);
        setup401Error();

        const props =
          oauthScope !== undefined
            ? { ...defaultProps, oauthScope }
            : defaultProps;
        await attemptConnection(props);

        if (expectScopeCall) {
          expect(mockDiscoverScopes).toHaveBeenCalledWith(
            defaultProps.sseUrl,
            undefined,
            expect.any(Function), // fetchFn when connectionType is proxy
          );
        } else {
          expect(mockDiscoverScopes).not.toHaveBeenCalled();
        }

        expect(mockAuth).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            serverUrl: defaultProps.sseUrl,
            scope: expectedAuthScope,
          }),
        );
      },
    );

    it("should handle slow scope discovery gracefully", async () => {
      mockDiscoverScopes.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(undefined), 100)),
      );

      setup401Error();
      await attemptConnection();

      expect(mockDiscoverScopes).toHaveBeenCalledWith(
        defaultProps.sseUrl,
        undefined,
        expect.any(Function), // fetchFn when connectionType is proxy
      );
      expect(mockAuth).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          serverUrl: defaultProps.sseUrl,
          scope: undefined,
        }),
      );
    });

    it("passes undefined fetchFn when connectionType is direct", async () => {
      mockDiscoverScopes.mockResolvedValue("read write");
      setup401Error();

      const directProps = {
        ...defaultProps,
        connectionType: "direct" as const,
      };
      await attemptConnection(directProps);

      expect(mockDiscoverScopes).toHaveBeenCalledWith(
        defaultProps.sseUrl,
        undefined,
        undefined, // fetchFn is undefined for direct
      );
      expect(mockAuth).toHaveBeenCalledWith(
        expect.any(Object),
        expect.not.objectContaining({ fetchFn: expect.anything() }),
      );
    });
  });

  describe("Inspector proxy McpError auth recovery", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockAuth.mockResolvedValue("AUTHORIZED");
      mockDiscoverScopes.mockResolvedValue(undefined);
      mockClient.connect.mockResolvedValue(undefined);
    });

    const attemptConnect = async (
      props: Parameters<typeof useConnection>[0] = defaultProps,
    ) => {
      const { result } = renderHook(() => useConnection(props));
      await act(async () => {
        try {
          await result.current.connect();
        } catch {
          // connect may throw when auth recovery does not retry
        }
      });
    };

    it("invokes auth when connect fails with inspector proxy transport McpError and upstream401 data", async () => {
      mockClient.connect.mockRejectedValueOnce(
        new McpError(MCP_PROXY_TRANSPORT_ERROR_CODE, "proxy transport", {
          upstream401: { body: "{}", contentType: "application/json" },
        }),
      );
      await attemptConnect();
      expect(mockAuth).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          serverUrl: defaultProps.sseUrl,
        }),
      );
    });

    it("invokes auth when connect fails with inspector proxy transport McpError and httpStatus 401", async () => {
      mockClient.connect.mockRejectedValueOnce(
        new McpError(MCP_PROXY_TRANSPORT_ERROR_CODE, "proxy transport", {
          httpStatus: 401,
        }),
      );
      await attemptConnect();
      expect(mockAuth).toHaveBeenCalled();
    });

    it("does not invoke auth for inspector proxy McpError without auth payload", async () => {
      mockClient.connect.mockRejectedValueOnce(
        new McpError(MCP_PROXY_TRANSPORT_ERROR_CODE, "proxy transport", {
          message: "upstream failure",
        }),
      );
      await attemptConnect();
      expect(mockAuth).not.toHaveBeenCalled();
    });

    it("does not invoke auth when httpStatus is 401 but JSON-RPC code is not inspector proxy", async () => {
      mockClient.connect.mockRejectedValueOnce(
        new McpError(-32603, "Internal error", { httpStatus: 401 }),
      );
      await attemptConnect();
      expect(mockAuth).not.toHaveBeenCalled();
    });
  });

  describe("MCP_PROXY_FULL_ADDRESS Configuration", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Reset the mock transport objects
      mockSSETransport.url = undefined;
      mockSSETransport.options = undefined;
      mockStreamableHTTPTransport.url = undefined;
      mockStreamableHTTPTransport.options = undefined;
    });

    test("sends proxyFullAddress query parameter for stdio transport when configured", async () => {
      const propsWithProxyFullAddress = {
        ...defaultProps,
        transportType: "stdio" as const,
        command: "test-command",
        args: "test-args",
        env: {},
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_FULL_ADDRESS: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_FULL_ADDRESS,
            value: "https://example.com/inspector/mcp_proxy",
          },
        },
      };

      const { result } = renderHook(() =>
        useConnection(propsWithProxyFullAddress),
      );

      await act(async () => {
        await result.current.connect();
      });

      // Check that the URL contains the proxyFullAddress parameter
      expect(mockSSETransport.url?.searchParams.get("proxyFullAddress")).toBe(
        "https://example.com/inspector/mcp_proxy",
      );
    });

    test("sends proxyFullAddress query parameter for sse transport when configured", async () => {
      const propsWithProxyFullAddress = {
        ...defaultProps,
        transportType: "sse" as const,
        sseUrl: "http://localhost:8080",
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_FULL_ADDRESS: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_FULL_ADDRESS,
            value: "https://example.com/inspector/mcp_proxy",
          },
        },
      };

      const { result } = renderHook(() =>
        useConnection(propsWithProxyFullAddress),
      );

      await act(async () => {
        await result.current.connect();
      });

      // Check that the URL contains the proxyFullAddress parameter
      expect(mockSSETransport.url?.searchParams.get("proxyFullAddress")).toBe(
        "https://example.com/inspector/mcp_proxy",
      );
    });

    test("does not send proxyFullAddress parameter when MCP_PROXY_FULL_ADDRESS is empty", async () => {
      const propsWithEmptyProxy = {
        ...defaultProps,
        transportType: "stdio" as const,
        command: "test-command",
        args: "test-args",
        env: {},
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_FULL_ADDRESS: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_FULL_ADDRESS,
            value: "",
          },
        },
      };

      const { result } = renderHook(() => useConnection(propsWithEmptyProxy));

      await act(async () => {
        await result.current.connect();
      });

      // Check that the URL does not contain the proxyFullAddress parameter
      expect(
        mockSSETransport.url?.searchParams.get("proxyFullAddress"),
      ).toBeNull();
    });

    test("does not send proxyFullAddress parameter for streamable-http transport", async () => {
      const propsWithStreamableHttp = {
        ...defaultProps,
        transportType: "streamable-http" as const,
        sseUrl: "http://localhost:8080",
        config: {
          ...DEFAULT_INSPECTOR_CONFIG,
          MCP_PROXY_FULL_ADDRESS: {
            ...DEFAULT_INSPECTOR_CONFIG.MCP_PROXY_FULL_ADDRESS,
            value: "https://example.com/inspector/mcp_proxy",
          },
        },
      };

      const { result } = renderHook(() =>
        useConnection(propsWithStreamableHttp),
      );

      await act(async () => {
        await result.current.connect();
      });

      // Check that streamable-http transport doesn't get proxyFullAddress parameter
      expect(
        mockStreamableHTTPTransport.url?.searchParams.get("proxyFullAddress"),
      ).toBeNull();
    });
  });
});
