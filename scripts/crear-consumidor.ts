/**
 * Alta de un consumidor sin pasar por la API de admin (primer arranque, o desde el contenedor):
 *   npm run consumidor:crear -- "Kiubo"
 * Imprime la API key UNA vez.
 */
import { prisma } from "../src/db";
import { crearConsumidor } from "../src/workers/consumidores";

const nombre = process.argv.slice(2).join(" ").trim();
if (!nombre) {
  console.error('Uso: npm run consumidor:crear -- "Nombre del sistema"');
  process.exit(1);
}
const c = await crearConsumidor(nombre);
console.log(`Consumidor: ${c.nombre} (${c.id})`);
console.log(`API key (guárdala, no se vuelve a mostrar): ${c.apiKey}`);
await prisma.$disconnect();
