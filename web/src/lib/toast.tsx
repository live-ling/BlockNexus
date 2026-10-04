// beUI AnimatedToastStack 的全局封装：任意组件 useToast() 即可弹 toast

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  AnimatedToastStack,
  useAnimatedToastStack,
  type ToastInput,
} from '@/components/motion/animated-toast-stack';

type ToastFn = (input: ToastInput) => void;

export interface ToastHelpers {
  toast: ToastFn;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastCtx = createContext<ToastHelpers>({
  toast: () => {},
  success: () => {},
  error: () => {},
  info: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const stack = useAnimatedToastStack({ limit: 5 });
  const { showToast } = stack;

  // 保持引用稳定：这些函数会出现在各组件 effect / useCallback 的依赖里，
  // 每次渲染换新引用会导致 effect 无限重跑。
  const helpers = useMemo<ToastHelpers>(
    () => ({
      toast: showToast,
      success: (title, description) => showToast({ title, description, status: 'success' }),
      error: (title, description) => showToast({ title, description, status: 'error' }),
      info: (title, description) => showToast({ title, description, status: 'info' }),
    }),
    [showToast],
  );

  return (
    <ToastCtx.Provider value={helpers}>
      {children}
      <AnimatedToastStack
        toasts={stack.toasts}
        onDismiss={stack.dismissToast}
        fixed
        position="bottom-right"
      />
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastCtx).toast;
}

export function useToastHelpers(): ToastHelpers {
  return useContext(ToastCtx);
}
