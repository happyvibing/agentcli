export function greet(name, opts = {}) {
  const message = `Hello, ${name}!`;
  console.log(opts.upper ? message.toUpperCase() : message);
}
