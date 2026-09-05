export function time(opts = {}) {
  const now = new Date();
  switch (opts.format) {
    case "locale":
      console.log(now.toLocaleString());
      break;
    case "unix":
      console.log(Math.floor(now.getTime() / 1000));
      break;
    case "iso":
    default:
      console.log(now.toISOString());
      break;
  }
}
