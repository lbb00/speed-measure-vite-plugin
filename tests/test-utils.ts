export function callHook(hook: any, ...args: any[]) {
  if (typeof hook === 'function') {
    return hook.apply(null, args)
  }
  if (hook && typeof hook === 'object' && typeof hook.handler === 'function') {
    return hook.handler.apply(null, args)
  }
}
