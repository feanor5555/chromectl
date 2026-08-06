/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The failure taxonomy of the chromectl front.
 *
 * Every refusal the front produces carries one of these kinds, and the kind is
 * what the answer's HTTP status and the client's exit code are read off. The
 * class lives in a module of its own and that module imports nothing, so every
 * part of the front throws and catches the same class: a second definition would
 * make `instanceof` quietly stop matching and turn a caller's mistake into a
 * fault of the service.
 */

/**
 * HTTP status per failure kind, mirroring the client's exit codes. `notfound`
 * belongs to the file route alone — a call never produces it, so it is the one
 * status the client's mapping does not have to carry.
 */
export const STATUS_BY_KIND = {
  usage: 400,
  notfound: 404,
  config: 500,
  storage: 500,
  busy: 409,
  tool: 422,
  unreachable: 503,
};

export class CallError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}
