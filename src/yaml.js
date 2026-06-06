/**
 * Minimal YAML parser for clagentic:triage.
 *
 * Handles the triage-intent.yml schema only:
 *   - Key: value pairs (string scalar values, possibly multi-line `|` block)
 *   - Simple arrays with `- item` entries
 *   - Nested objects (indented key: value)
 *   - Comments (#)
 *
 * Does NOT handle anchors, aliases, flow mappings, or complex types.
 * If the input does not look like YAML (no colon-separated key), it is
 * returned as { description: rawString }.
 */

/**
 * Remove inline YAML comments, but only outside of block scalars.
 * Strips everything from the first ` #` that is preceded by whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
function _stripComment(line) {
  // Only strip free-standing comments — not `#` that is part of a value.
  // A comment must be preceded by whitespace (or start of line) and be followed
  // by a space or end of string. This avoids stripping `#issue-123` or similar.
  return line.replace(/(^|\s)#(\s|$).*$/, '').trimEnd();
}

/**
 * Count leading spaces (indentation level).
 *
 * @param {string} line
 * @returns {number}
 */
function _indent(line) {
  return line.length - line.trimStart().length;
}

/**
 * Parse a minimal YAML string into a plain object.
 * Scoped to the triage-intent.yml schema — not a general YAML parser.
 *
 * @param {string} yaml
 * @returns {object}
 */
export function parseYaml(yaml) {
  // If the input looks like pure prose (no `key: value` line at top level),
  // treat it as a raw description string.
  const hasKeyValueLine = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(yaml);
  if (!hasKeyValueLine) {
    return { description: yaml };
  }

  const lines = yaml.split('\n');

  /**
   * Recursive parse: consume lines starting at `startIdx` that have
   * indentation > `parentIndent`. Returns { result, nextIdx }.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: object | string[], nextIdx: number }}
   */
  function parseBlock(startIdx, parentIndent) {
    // Peek at the first non-empty, non-comment line to decide if this block
    // is a mapping (key: value) or a sequence (- item).
    let peekIdx = startIdx;
    while (peekIdx < lines.length) {
      const raw = lines[peekIdx];
      const stripped = _stripComment(raw);
      if (stripped.trim() === '' || stripped.trim().startsWith('#')) {
        peekIdx++;
        continue;
      }
      break;
    }

    if (peekIdx >= lines.length) {
      return { result: {}, nextIdx: startIdx };
    }

    const peekLine = _stripComment(lines[peekIdx]);
    const isSequence = peekLine.trimStart().startsWith('- ') || peekLine.trimStart() === '-';

    if (isSequence) {
      return parseSequence(startIdx, parentIndent);
    }
    return parseMapping(startIdx, parentIndent);
  }

  /**
   * Parse a YAML mapping block.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: object, nextIdx: number }}
   */
  function parseMapping(startIdx, parentIndent) {
    const obj = {};
    let i = startIdx;

    while (i < lines.length) {
      const rawLine = lines[i];
      const strippedLine = _stripComment(rawLine);

      // Skip blank lines and pure comment lines
      if (strippedLine.trim() === '') {
        i++;
        continue;
      }

      const currentIndent = _indent(strippedLine);

      // Stop when we step back to or above the parent indent level
      if (currentIndent <= parentIndent && i !== startIdx) {
        break;
      }

      const trimmed = strippedLine.trimStart();

      // Check for a key: (value?) pattern
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        // Not a key line — skip (could be a continuation, handled below)
        i++;
        continue;
      }

      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();

      i++;

      if (rest === '|') {
        // Block scalar — collect indented lines that follow
        const scalarLines = [];
        while (i < lines.length) {
          const nextRaw = lines[i];
          if (nextRaw.trim() === '') {
            // Blank lines are part of the block scalar
            scalarLines.push('');
            i++;
            continue;
          }
          const nextIndent = _indent(nextRaw);
          if (nextIndent <= currentIndent) {
            break;
          }
          // Preserve relative indentation by stripping the base indent
          const baseIndent = currentIndent + 2;
          const stripped = nextRaw.slice(Math.min(baseIndent, nextIndent));
          scalarLines.push(stripped);
          i++;
        }
        // Trim trailing blank lines, join with newline
        while (scalarLines.length > 0 && scalarLines[scalarLines.length - 1] === '') {
          scalarLines.pop();
        }
        obj[key] = scalarLines.join('\n');
      } else if (rest === '' || rest === null) {
        // No inline value — look ahead for a nested block
        if (i < lines.length) {
          const nextRaw = lines[i];
          const nextStripped = _stripComment(nextRaw);
          if (nextStripped.trim() === '') {
            obj[key] = null;
          } else {
            const nextIndent = _indent(nextStripped);
            if (nextIndent > currentIndent) {
              const nested = parseBlock(i, currentIndent);
              obj[key] = nested.result;
              i = nested.nextIdx;
            } else {
              obj[key] = null;
            }
          }
        } else {
          obj[key] = null;
        }
      } else {
        // Inline scalar value — strip optional surrounding quotes
        obj[key] = _unquote(rest);
      }
    }

    return { result: obj, nextIdx: i };
  }

  /**
   * Parse a YAML sequence block.
   *
   * @param {number} startIdx
   * @param {number} parentIndent
   * @returns {{ result: Array, nextIdx: number }}
   */
  function parseSequence(startIdx, parentIndent) {
    const arr = [];
    let i = startIdx;

    while (i < lines.length) {
      const rawLine = lines[i];
      const strippedLine = _stripComment(rawLine);

      if (strippedLine.trim() === '') {
        i++;
        continue;
      }

      const currentIndent = _indent(strippedLine);

      // Stop when we step back to or above parent indent
      if (currentIndent <= parentIndent && i !== startIdx) {
        break;
      }

      const trimmed = strippedLine.trimStart();

      if (!trimmed.startsWith('- ') && trimmed !== '-') {
        // Not a sequence item at this level — stop
        break;
      }

      const itemContent = trimmed.slice(2).trim(); // strip leading "- "
      i++;

      if (itemContent === '') {
        // Multi-line sequence item — parse as a nested block
        if (i < lines.length) {
          const nextStripped = _stripComment(lines[i]);
          if (nextStripped.trim() !== '' && _indent(nextStripped) > currentIndent) {
            const nested = parseBlock(i, currentIndent);
            arr.push(nested.result);
            i = nested.nextIdx;
          } else {
            arr.push(null);
          }
        } else {
          arr.push(null);
        }
      } else if (itemContent.includes(':')) {
        // Inline mapping shorthand: `- key: value`
        // Parse the item as a single-entry mapping plus any indented continuation
        const colonIdx = itemContent.indexOf(':');
        const itemKey = itemContent.slice(0, colonIdx).trim();
        const itemVal = itemContent.slice(colonIdx + 1).trim();

        const entryObj = {};
        entryObj[itemKey] = itemVal === '' ? null : _unquote(itemVal);

        // Look ahead for additional keys at the same indent level (indented relative to `- `)
        while (i < lines.length) {
          const nextRaw = lines[i];
          const nextStripped = _stripComment(nextRaw);
          if (nextStripped.trim() === '') {
            i++;
            continue;
          }
          const nextIndent = _indent(nextStripped);
          if (nextIndent <= currentIndent) {
            break;
          }
          const nextTrimmed = nextStripped.trimStart();
          const nextColonIdx = nextTrimmed.indexOf(':');
          if (nextColonIdx === -1) {
            break;
          }
          const nextKey = nextTrimmed.slice(0, nextColonIdx).trim();
          const nextVal = nextTrimmed.slice(nextColonIdx + 1).trim();
          entryObj[nextKey] = nextVal === '' ? null : _unquote(nextVal);
          i++;
        }

        arr.push(entryObj);
      } else {
        arr.push(_unquote(itemContent));
      }
    }

    return { result: arr, nextIdx: i };
  }

  /**
   * Strip surrounding single or double quotes from a scalar value.
   *
   * @param {string} s
   * @returns {string}
   */
  function _unquote(s) {
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  try {
    const { result } = parseBlock(0, -1);
    return result;
  } catch (err) {
    // If parsing fails for any reason, return the raw input as a description.
    console.warn(`[yaml] YAML parse error: ${err.message}`);
    return { description: yaml };
  }
}
