import { randomUUID } from 'node:crypto';

interface HandleEntry {
  value: any;
  type: string;
}

const handles = new Map<string, HandleEntry>();

export function storeHandle(value: any, typeHint?: string): string {
  const id = randomUUID();
  const type = typeHint ?? value?.constructor?.name ?? 'Object';
  handles.set(id, { value, type });
  return id;
}

export function getHandle(id: string): HandleEntry | undefined {
  return handles.get(id);
}

export function releaseHandle(id: string): boolean {
  return handles.delete(id);
}

export function listHandles(): { id: string; type: string }[] {
  return Array.from(handles.entries()).map(([id, entry]) => ({ id, type: entry.type }));
}
