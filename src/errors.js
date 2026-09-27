/**
 * @typedef {'ROOT_NOT_FOUND'|'ROOT_EXISTS'|'ROOT_HAS_NOTES'|'CONFIG_INVALID'
 *   |'PATH_ESCAPES_ROOT'|'PATH_IN_STATE_DIR'|'PATH_IN_OTHER_ROOT'|'NOTE_NOT_FOUND'|'NOTE_EXISTS'|'VERSION_NOT_FOUND'
 *   |'LOCK_TIMEOUT'|'NOTE_CHANGED'|'EDIT_NOT_FOUND'|'EDIT_AMBIGUOUS'|'NO_SESSION'|'PENDING_NOT_FOUND'|'MESSAGE_NOT_FOUND'
 *   |'PACK_INVALID'|'PACK_NOT_FOUND'} ErrorCode
 */

/** Every error this package raises on purpose. The message says what failed and what to do. */
export class MnemeError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MnemeError';
    /** @type {ErrorCode} */
    this.code = code;
  }
}
