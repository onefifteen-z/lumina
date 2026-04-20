import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { trace, Tracer } from "@opentelemetry/api";
import type { AttributeValue } from "@opentelemetry/api";
import type { PhoenixConfig } from "../shared/types";

let sdk: NodeSDK | null = null;
let enabled = false;

function buildEndpointUrl(scheme: string, host: string, port: number): string {
  return `${scheme}://${host}:${port}/v1/traces`;
}

function startSdk(config: PhoenixConfig): void {
  const exporter = new OTLPTraceExporter({
    url: buildEndpointUrl(config.scheme, config.host, config.port),
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "lumina",
      "openinference.project.name": "lumina",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  sdk.start();
}

export function isPhoenixEnabled(): boolean {
  return enabled;
}

export function initTelemetry(config?: PhoenixConfig): void {
  enabled = config?.enabled ?? false;
  if (enabled) {
    startSdk(config!);
  }
}

export async function reconfigureTelemetry(config: PhoenixConfig): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
  enabled = config.enabled;
  if (enabled) {
    startSdk(config);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) await sdk.shutdown();
}

export function getTracer(): Tracer {
  return trace.getTracer("lumina", "0.8.2");
}

export function startSpan(
  name: string,
  attributes?: Record<string, AttributeValue>,
  parentCtx?: import("@opentelemetry/api").Context,
): import("@opentelemetry/api").Span | null {
  if (!enabled) return null;
  const span = getTracer().startSpan(name, {}, parentCtx);
  if (attributes) span.setAttributes(attributes);
  return span;
}
