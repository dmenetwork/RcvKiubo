/** Error con forma de respuesta HTTP: lo lanza un worker y lo traduce el middleware de errores. */
export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles?: unknown,
  ) {
    super(mensaje);
    this.name = "ErrorHttp";
  }
}

export const noEncontrado = (que: string) => new ErrorHttp(404, "NO_ENCONTRADO", `${que} no existe.`);
