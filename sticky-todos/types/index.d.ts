export type Todo = { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    'sticky-todos': { todos: Todo[] }
  }
}
