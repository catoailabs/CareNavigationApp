import { create } from 'zustand'

type AuthStore = {
  user: { id: string } | null;
};

export const useAuthStore = create<AuthStore>(() => ({
  user: { id: 'test-user-123' },
}));