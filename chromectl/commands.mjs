/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The command surface of the chromectl front.
 *
 * What the front offers and how a caller's arguments are checked against it, in
 * one place and with no list of its own: the surface is taken whole from
 * upstream's generated command table, which is what the daemon registers its
 * tools from, so the front is a proxy and not a filter. An upstream bump brings
 * its new tools and arguments along by itself.
 *
 * The check and the table sit together on purpose. `validateArgs` reads the
 * schemas on every call, and a table in one module with the loop that reads it
 * in another is how a command comes to be offered under a schema nobody
 * enforces.
 */

import {commands as upstreamCommands} from '../build/src/bin/chrome-devtools-cli-options.js';

import {CallError} from './errors.mjs';

/**
 * Every command the front offers and the argument schema of each, taken whole
 * from upstream's generated command table (`chrome-devtools-cli-options.js`)
 * rather than kept as an own copy. The table is what the daemon registers its
 * tools from, so the front's surface is the daemon's surface, and an upstream
 * change — a new tool, a new argument on an existing one — arrives with the
 * merge instead of being dropped behind a list kept by hand.
 */
export const COMMAND_SCHEMAS = new Map(
  Object.entries(upstreamCommands).map(([command, definition]) => [
    command,
    definition.args ?? {},
  ]),
);

/** The command names, sorted, as `/health` reports them. */
export const COMMANDS = [...COMMAND_SCHEMAS.keys()].sort();

/**
 * The values upstream declares for one argument of a fixed set, and the one it
 * falls back to when a caller names none. A tool whose output carries the
 * format it was asked for takes its endings from here rather than from a list
 * kept beside it, so a format upstream adds arrives with the merge. An argument
 * that no longer carries such a set stops the front at startup, the same way an
 * unaccounted argument does.
 */
export function enumeratedArgument(command, argument) {
  const definition = COMMAND_SCHEMAS.get(command)?.[argument];
  if (definition?.enum === undefined) {
    throw new Error(
      `chromectl: ${command}.${argument} carries no fixed set of values in the ` +
        `command table, so the endings of ${command} cannot be taken from it`,
    );
  }
  return {
    values: definition.enum,
    fallback: definition.default ?? definition.enum[0],
  };
}

/**
 * Brings one argument to the type upstream declared for it. A caller that can
 * only send text — the bash client — passes every value as a string, so a
 * declared boolean or number is accepted in its written form as well, but only
 * when the text really is one; a string argument keeps whatever text it carries,
 * spaces, URLs and umlauts included.
 */
function coerceArgument(command, definition, value) {
  const fail = expected => {
    throw new CallError(
      'usage',
      `${command}: argument ${definition.name} must be ${expected}, got ${JSON.stringify(value)}`,
    );
  };

  let coerced = value;
  switch (definition.type) {
    case 'string':
      if (typeof coerced !== 'string') {
        fail('a string');
      }
      break;
    case 'boolean':
      if (coerced === 'true' || coerced === 'false') {
        coerced = coerced === 'true';
      }
      if (typeof coerced !== 'boolean') {
        fail('a boolean');
      }
      break;
    case 'number':
    case 'integer':
      if (typeof coerced === 'string' && coerced.trim() !== '') {
        coerced = Number(coerced);
      }
      if (typeof coerced !== 'number' || !Number.isFinite(coerced)) {
        fail('a number');
      }
      if (definition.type === 'integer' && !Number.isInteger(coerced)) {
        fail('an integer');
      }
      break;
    case 'array':
      // A caller that can only send text cannot write a list at all, so a lone
      // string counts as the one-element list — `wait_for --text "…"` is the
      // whole of the exposed array surface, and without this the command is
      // offered and uncallable from the bash client.
      if (typeof coerced === 'string') {
        coerced = [coerced];
      }
      if (!Array.isArray(coerced)) {
        fail('an array');
      }
      break;
    default:
      throw new CallError(
        'config',
        `${command}: unsupported argument type ${definition.type} for ${definition.name}`,
      );
  }

  if (definition.enum && !definition.enum.includes(coerced)) {
    fail(`one of ${definition.enum.join(', ')}`);
  }
  return coerced;
}

/**
 * The full-speed switch of one call. It sits beside `args` rather than inside
 * them: no tool declares it, so it has no entry in `COMMAND_SCHEMAS` and must
 * never be handed to the daemon as a tool argument — the tool would reject the
 * call as carrying an unknown one. Its coercion is the one every declared
 * boolean gets, so a caller who can only send text writes `"true"`.
 */
const FULL_SPEED_DEFINITION = {
  name: 'full_speed',
  type: 'boolean',
  description: 'Lifts human pacing for this call.',
  required: false,
};

export function validateFullSpeed(value) {
  if (value === undefined || value === null) {
    return false;
  }
  return coerceArgument('call', FULL_SPEED_DEFINITION, value);
}

/** A name upstream does not know never reaches the daemon. */
export function assertKnownCommand(command) {
  if (typeof command !== 'string' || !COMMAND_SCHEMAS.has(command)) {
    throw new CallError(
      'usage',
      `unknown command: ${JSON.stringify(command)} — GET /health names the ` +
        `${COMMANDS.length} commands this front offers`,
    );
  }
}

/**
 * Checks the caller's arguments against the command's schema and returns them
 * typed. Unknown names and missing required ones are rejected here, before the
 * daemon is involved, so they come back as a usage error rather than as a tool
 * failure.
 */
export function validateArgs(command, args) {
  if (args === undefined || args === null) {
    args = {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new CallError('usage', `${command}: args must be a JSON object`);
  }

  const schema = COMMAND_SCHEMAS.get(command);
  const validated = {};
  for (const [name, value] of Object.entries(args)) {
    // Asked for the schema's own names only: `constructor` and its like are
    // truthy on every object and would slip past this refusal to fail later as
    // a fault of the service.
    const definition = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!definition) {
      const known = Object.keys(schema).join(', ') || 'none';
      throw new CallError(
        'usage',
        `${command}: unknown argument ${name} (known: ${known})`,
      );
    }
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      throw new CallError('usage', `${command}: argument ${name} is null`);
    }
    validated[name] = coerceArgument(command, definition, value);
  }

  for (const [name, definition] of Object.entries(schema)) {
    if (definition.required && validated[name] === undefined) {
      throw new CallError(
        'usage',
        `${command}: required argument ${name} is missing`,
      );
    }
  }
  return validated;
}
