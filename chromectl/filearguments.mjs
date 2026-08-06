/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the tools of the chromectl front read and write.
 *
 * One table says which argument of which command carries a path and what the
 * front does with it, the two others say which arguments carry no path at all —
 * by name where the name is enough, by command and name where it is not — and
 * between the three every argument upstream declares is accounted for. All are
 * declarations only: the procedures that plan, stage and describe a file act on
 * them from elsewhere, and keeping the tables apart from those procedures is
 * what makes the file to look at after an upstream bump the small one.
 *
 * Loading this module runs the two checks below, which is what makes the front
 * refuse to come up while a tool argument or a file ending is unaccounted for.
 * They are the counterpart of `filenames.mjs`: what the tools can produce, held
 * against what the front can serve.
 */

import {COMMAND_SCHEMAS, COMMANDS, enumeratedArgument} from './commands.mjs';
import {
  CONTENT_TYPE_BY_EXTENSION,
  FILE_EXTENSIONS,
  SPILL_EXTENSION,
} from './filenames.mjs';

/** The heap snapshot a reader tool is pointed at: written by an earlier call. */
const HEAP_SNAPSHOT_INPUT = {direction: 'in', extensions: ['heapsnapshot']};

/**
 * The path arguments of every command, and what the front does with each.
 *
 * `out` is a file the daemon writes. The directory is the front's decision and a
 * caller names at most the file, so the answer can hand back a location the
 * caller actually reaches; the name lands in the answer under `kind`, with a
 * fetch URL beside it. `always` marks an argument the front fills in whether or
 * not the caller named one, because the payload would otherwise travel inline or
 * into a temp directory nobody can reach — the image of a screenshot, the video
 * of a recording. `optional` marks a file a tool writes only when the page had
 * the content it would hold, so its absence is a result and not a failure.
 * `deferred` marks the one whose file is finished by a later call; that one is
 * never optional, since the call finishing it is the call that promised it.
 *
 * `extensions` are the endings a tool enforces, the first of them the one a name
 * the front builds itself carries. `extensionsFrom` stands in its place where
 * the ending is the format the caller asked for: it names the argument that
 * carries it, and both the ending and the fallback come out of the command
 * table instead of being written down here a second time.
 *
 * `out-dir` is a directory a tool fills with files of its own naming. The front
 * hands it one of its own, takes the files named in `reports` out of it
 * afterwards and removes it.
 *
 * `in` is a file the daemon reads, `in-dir` a directory it reads. Both are
 * looked up in `OUTPUT_DIR`: that directory lies on the network drive every
 * machine reaches, so a caller on another machine puts the file there — or an
 * earlier call of its own wrote it — and names it here.
 *
 * The heap snapshot readers are derived from the command table instead of being
 * listed, so an upstream bump brings its new ones along.
 */
export const FILE_ARGUMENTS = {
  take_screenshot: {
    filePath: {
      direction: 'out',
      kind: 'screenshot',
      always: true,
      extensionsFrom: 'format',
    },
  },
  take_snapshot: {
    filePath: {direction: 'out', kind: 'snapshot', extensions: ['txt']},
  },
  evaluate_script: {
    filePath: {direction: 'out', kind: 'output', extensions: ['json']},
  },
  take_heapsnapshot: {
    filePath: {
      direction: 'out',
      kind: 'heapsnapshot',
      extensions: ['heapsnapshot'],
    },
  },
  performance_start_trace: {
    filePath: {
      direction: 'out',
      kind: 'trace',
      extensions: ['json', 'json.gz'],
      optional: true,
    },
  },
  performance_stop_trace: {
    filePath: {
      direction: 'out',
      kind: 'trace',
      extensions: ['json', 'json.gz'],
      optional: true,
    },
  },
  get_network_request: {
    requestFilePath: {
      direction: 'out',
      kind: 'request_body',
      extensions: ['network-request'],
      optional: true,
    },
    responseFilePath: {
      direction: 'out',
      kind: 'response_body',
      extensions: ['network-response'],
      optional: true,
    },
  },
  screencast_start: {
    filePath: {
      direction: 'out',
      kind: 'recording',
      always: true,
      deferred: true,
      extensions: ['mp4', 'webm'],
    },
  },
  lighthouse_audit: {
    outputDirPath: {
      direction: 'out-dir',
      always: true,
      reports: {'report.json': 'report_json', 'report.html': 'report_html'},
    },
  },
  upload_file: {filePath: {direction: 'in', staged: true}},
  install_extension: {path: {direction: 'in-dir'}},
  close_heapsnapshot: {filePath: HEAP_SNAPSHOT_INPUT},
  compare_heapsnapshots: {
    baseFilePath: HEAP_SNAPSHOT_INPUT,
    currentFilePath: HEAP_SNAPSHOT_INPUT,
  },
};

for (const command of COMMANDS) {
  if (command.startsWith('get_heapsnapshot_')) {
    FILE_ARGUMENTS[command] = {filePath: HEAP_SNAPSHOT_INPUT};
  }
}

/**
 * The endings one path argument may carry in one call: the format the caller
 * asked for where the tool names its output by one, the fixed set otherwise. The
 * first is the ending a name the front builds itself gets.
 */
export function extensionsOf(command, spec, toolArgs) {
  if (spec.extensionsFrom === undefined) {
    return spec.extensions ?? [];
  }
  const {fallback} = enumeratedArgument(command, spec.extensionsFrom);
  return [toolArgs[spec.extensionsFrom] ?? fallback];
}

/** Every ending one path argument can carry, over all calls a caller can make. */
function possibleExtensionsOf(command, spec) {
  if (spec.extensionsFrom === undefined) {
    return spec.extensions ?? [];
  }
  return enumeratedArgument(command, spec.extensionsFrom).values;
}

/** The ending a report of an output directory carries: `report.json` is a json. */
export function reportExtension(name) {
  return name.slice(name.indexOf('.') + 1);
}

/**
 * Every argument of the command table that carries no path on the machine the
 * front runs on, whichever command declares it: a uid, a page index, a viewport,
 * a timeout. It is one counterpart of `FILE_ARGUMENTS`, and between the tables
 * every argument upstream declares is accounted for.
 *
 * The names here say what they hold wherever they turn up, so a tool an upstream
 * bump adds may carry them without being looked at again. A name that says
 * nothing on its own — `input`, `value`, `params` — belongs in
 * `NON_PATH_COMMAND_ARGUMENTS` instead.
 */
const NON_PATH_ARGUMENTS = new Set([
  'action',
  'autoStop',
  'background',
  'bringToFront',
  'classIndex',
  'colorScheme',
  'cpuThrottlingRate',
  'dblClick',
  'device',
  'dialogAction',
  'extraHttpHeaders',
  'filterName',
  'from_uid',
  'fullPage',
  'function',
  'geolocation',
  'handleBeforeUnload',
  'height',
  'ignoreCache',
  'includePreservedMessages',
  'includePreservedRequests',
  'includeSnapshot',
  'initScript',
  'insightName',
  'insightSetId',
  'isolatedContext',
  'maxDepth',
  'maxNodes',
  'maxSiblings',
  'msgid',
  'networkConditions',
  'nodeId',
  'objectId',
  'pageId',
  'pageIdx',
  'pageSize',
  'promptText',
  'quality',
  'reload',
  'reqid',
  'resourceTypes',
  'serviceWorkerId',
  'submitKey',
  'timeout',
  'to_uid',
  'toolName',
  'uid',
  'userAgent',
  'verbose',
  'viewport',
  'width',
  'x',
  'y',
]);

/**
 * The arguments that carry no path on the command that declares them, keyed
 * `command.argument`.
 *
 * A container-ish name says nothing about what it holds: `input`, `value`,
 * `params`, `args`, `id`, `key`, `mode`, `type`, `types`, `text`, `url` and
 * `format` each mean whatever the one tool declaring them means by it today. Let
 * in by name, they would account in advance for an argument of a tool nobody has
 * read yet — which is the one gap a check by name has, and the reason the entry
 * names the command as well. Every pair here is the command the built table
 * gives that name to; the same name on any other command stops the front at
 * startup until someone says what it holds there.
 */
const NON_PATH_COMMAND_ARGUMENTS = new Set([
  'evaluate_script.args',
  'execute_3p_developer_tool.params',
  'execute_webmcp_tool.input',
  'fill.value',
  'get_heapsnapshot_class_nodes.id',
  'lighthouse_audit.mode',
  'list_console_messages.types',
  'navigate_page.type',
  'navigate_page.url',
  'new_page.url',
  'press_key.key',
  'reload_extension.id',
  'take_screenshot.format',
  'trigger_extension_action.id',
  'type_text.text',
  'uninstall_extension.id',
  'wait_for.text',
]);

/**
 * Refuses to start while one argument of the command table is unaccounted for.
 *
 * The daemon runs with `--allowUnrestrictedPaths` (`DAEMON_ARGS` in
 * `daemon.mjs`), so a path that travelled through as the caller wrote it would
 * read and write wherever the front's user can, from an endpoint that asks for
 * no authentication. Every path argument the front knows is filled in by the
 * front itself, and the question is what happens to the one it does not know
 * yet: an upstream bump adds a tool, its arguments pass `validateArgs` because
 * they are in the schema, and nothing else stands between them and the daemon.
 *
 * The check is therefore against the tables rather than against how an argument
 * is spelled — upstream names its path arguments `…Path` today, but that is
 * upstream's habit and not a property this fork may rest on. An argument that is
 * in no table stops the front at startup, which is the loud failure a merge is
 * looked at again after; the alternative is a silent path escape at the moment
 * nobody is looking. Clearing it is one entry: into `FILE_ARGUMENTS` when the
 * argument carries a path, into `NON_PATH_ARGUMENTS` when it carries none and
 * its name says so on any command, into `NON_PATH_COMMAND_ARGUMENTS` when only
 * the command it belongs to says what it holds.
 *
 * The tables are parameters so that the refusal itself can be exercised against
 * tables that do not match; the call below passes none and holds the real ones,
 * and that call is what the front's start rests on.
 */
export function assertArgumentsAccountedFor(
  schemas = COMMAND_SCHEMAS,
  fileArguments = FILE_ARGUMENTS,
  nonPathArguments = NON_PATH_ARGUMENTS,
  scopedNonPathArguments = NON_PATH_COMMAND_ARGUMENTS,
) {
  const unaccounted = [];
  for (const [command, schema] of schemas) {
    for (const argument of Object.keys(schema)) {
      // Asked for the table's own names only: `constructor` and its like are
      // truthy on every object and would pass as accounted for while nothing in
      // the tables ever named them.
      if (
        Object.hasOwn(fileArguments[command] ?? {}, argument) ||
        nonPathArguments.has(argument) ||
        scopedNonPathArguments.has(`${command}.${argument}`)
      ) {
        continue;
      }
      unaccounted.push(`${command}.${argument}`);
    }
  }
  if (unaccounted.length > 0) {
    throw new Error(
      `unknown tool arguments, each has to be entered into FILE_ARGUMENTS, ` +
        `into NON_PATH_ARGUMENTS or into NON_PATH_COMMAND_ARGUMENTS before the ` +
        `front can serve them: ${unaccounted.join(', ')}`,
    );
  }
}

assertArgumentsAccountedFor();

/**
 * Refuses to start while one ending a call can produce is unknown to the front.
 *
 * `FILE_EXTENSIONS` decides which names the file route hands out again and
 * `CONTENT_TYPE_BY_EXTENSION` what such a file is served as. A media type is
 * declared nowhere upstream, so that table stays one kept here, and the endings
 * a call can produce are held against it: the values of the argument a tool
 * names its output by, the fixed endings of every other path argument, the
 * reports taken out of an output directory and the ending a spilled result
 * carries.
 *
 * Left unchecked, a file with such an ending is written, named in the answer and
 * then refused by the front's own file route with 400, or handed over as a
 * stream of bytes — both only at the moment a caller fetches it, long after the
 * merge that brought it. Clearing it is one entry per table.
 *
 * The tables are parameters for the same reason the ones above are, and the call
 * below is likewise the one the front's start rests on.
 */
export function assertExtensionsAccountedFor(
  fileArguments = FILE_ARGUMENTS,
  extensions = FILE_EXTENSIONS,
  contentTypes = CONTENT_TYPE_BY_EXTENSION,
) {
  const unknown = new Map();
  const note = (extension, source) => {
    if (
      extensions.includes(extension) &&
      contentTypes[extension] !== undefined
    ) {
      return;
    }
    unknown.set(extension, source);
  };
  for (const [command, specs] of Object.entries(fileArguments)) {
    for (const [argument, spec] of Object.entries(specs)) {
      for (const extension of possibleExtensionsOf(command, spec)) {
        note(extension, `${command}.${argument}`);
      }
      for (const report of Object.keys(spec.reports ?? {})) {
        note(reportExtension(report), `${command}.${argument}`);
      }
    }
  }
  note(SPILL_EXTENSION, 'a spilled result');
  if (unknown.size > 0) {
    const named = [...unknown]
      .map(([extension, source]) => `.${extension} (${source})`)
      .join(', ');
    throw new Error(
      `unknown file endings, each has to be entered into FILE_EXTENSIONS and ` +
        `into CONTENT_TYPE_BY_EXTENSION before the front can serve them: ${named}`,
    );
  }
}

assertExtensionsAccountedFor();
