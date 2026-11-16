export function dispatch({ url, phase }) {
  if (url.pathname === '/subscription') return { json: {
    dialog: phase ? 'dlg-2' : 'dlg-1', event: 'presence', expires: 120,
    notifications: phase ? ['/notify/rebuilt', '/notify/1'] : ['/notify/1', '/notify/gap'] } };
  return null;
}
