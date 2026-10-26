import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Qué direcciones NO puede alcanzar un webhook. Una API key no debe poder usar al servicio para
 * pegarle a su propia red (SSRF): metadatos de la nube, la base, el panel del router.
 *
 * `BlockList` compara también las IPv4 mapeadas en IPv6 (`::ffff:127.0.0.1`) contra las reglas IPv4.
 */
const PROHIBIDAS = new BlockList();
for (const [red, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (Tailscale)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / metadatos de la nube
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4],
] as const) {
  PROHIBIDAS.addSubnet(red, bits, "ipv4");
}
PROHIBIDAS.addAddress("::", "ipv6");
PROHIBIDAS.addAddress("::1", "ipv6");
PROHIBIDAS.addSubnet("fc00::", 7, "ipv6"); // ULA
PROHIBIDAS.addSubnet("fe80::", 10, "ipv6"); // link-local
PROHIBIDAS.addSubnet("ff00::", 8, "ipv6"); // multicast
PROHIBIDAS.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 → podría apuntar a una IPv4 interna

export function esIpProhibida(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true; // lo que no es una IP no se deja pasar como si lo fuera
  return PROHIBIDAS.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/** El host de una URL, sin corchetes ni el punto final (`localhost.` es `localhost`). */
export function hostNormalizado(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** Nombres que apuntan a la propia máquina o a la red local sin necesidad de resolverlos. */
export function esNombreLocal(host: string): boolean {
  return host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes(".");
}

type CallbackLookup = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` para el socket: resuelve como siempre y RECHAZA si alguna dirección es prohibida. Va al
 * conectar, no al validar la URL: así un nombre público que resuelve a una IP privada (o que cambia
 * entre la validación y el envío, DNS rebinding) tampoco pasa.
 */
export function lookupSeguro(hostname: string, opciones: object, callback: CallbackLookup): void {
  dnsLookup(hostname, opciones as { all?: boolean }, ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
    if (err) return callback(err, address, family);
    const ips = Array.isArray(address) ? address.map((a) => a.address) : [address];
    const mala = ips.find(esIpProhibida);
    if (mala) {
      const e = new Error(`El webhook resuelve a una dirección no permitida (${mala}).`) as NodeJS.ErrnoException;
      e.code = "EWEBHOOKPROHIBIDO";
      return callback(e, address, family);
    }
    callback(null, address, family);
  }) as never);
}
