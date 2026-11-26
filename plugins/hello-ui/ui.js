export function activate(api) {
  api.addCommand({
    id: 'hello-ui.hello',
    label: 'Hello from a renderer plugin',
    run: () => api.notify('Hello from plugins/hello-ui/ui.js')
  })
}
