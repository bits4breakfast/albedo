/**
 * The buttons that send a command, as the command's echo names them after
 * "from" (#384, commandEcho.ts). Passed to `sendToSession` as its `from`; a
 * label only, it never changes what is written. Its own module, so a test
 * that stands in for send.ts still has the labels.
 */
export const SEND_FROM = {
  compact: 'Compact Now',
  clear: 'Clear',
  model: 'the model picker',
  remote: 'Remote Control',
  rename: 'Rename',
} as const;
