import { config } from "../config";
import { ClienteSii } from "../sii/cliente";

/** El cliente del SII del proceso: uno solo, para que el caché de tokens y el tope de concurrencia sean globales. */
let cliente: ClienteSii | null = null;

export function clienteSii(): ClienteSii {
  cliente ??= new ClienteSii({ concurrencia: config().SII_CONCURRENCIA, timeoutMs: config().SII_TIMEOUT_MS });
  return cliente;
}

/** Sólo tests: inyectar un cliente con un `fetch` falso. */
export function usarClienteSii(c: ClienteSii | null): void {
  cliente = c;
}
