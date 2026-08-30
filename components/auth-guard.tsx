'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff, LoaderCircle, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BRAND_LOGO_PATH, BRAND_NAME } from '@/lib/brand';
import { getAuthSession, signIn, signOut, signUp } from '@/lib/auth/client';
import type { AuthUser } from '@/lib/auth/types';

type AuthMode = 'sign-in' | 'sign-up';

function messageForAuthError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return '邮箱或密码不正确。';
  if (normalized.includes('email not confirmed')) return '请先打开验证邮件完成邮箱验证。';
  if (normalized.includes('user already registered')) return '该邮箱已注册，请直接登录。';
  if (normalized.includes('password')) return '密码至少需要 8 个字符。';
  return '暂时无法完成登录，请稍后重试。';
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const emailId = useId();
  const passwordId = useId();
  const feedbackId = useId();
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    void getAuthSession(controller.signal)
      .then((session) => {
        if (!active) return;
        setConfigured(session.configured);
        setUser(session.user);
      })
      .catch(() => {
        if (!active) return;
        setConfigured(true);
        setError('登录服务暂时不可用，请重试。');
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  if (configured === false) return children;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setNotice('');

    const trimmedEmail = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setError('请输入有效的邮箱地址。');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 个字符。');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }

    setSubmitting(true);
    try {
      const result =
        mode === 'sign-in'
          ? await signIn(trimmedEmail, password)
          : await signUp(trimmedEmail, password);
      if (result.user) {
        setUser(result.user);
        router.replace('/workspace');
      } else if (mode === 'sign-up' && result.needsEmailConfirmation) {
        setNotice('验证邮件已发送。完成邮箱验证后即可登录。');
        setMode('sign-in');
        setPassword('');
      }
    } catch (authError) {
      setError(messageForAuthError(authError instanceof Error ? authError.message : ''));
      setPassword('');
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await signOut();
      setUser(null);
      setPassword('');
      router.replace('/');
    } catch {
      setError('暂时无法退出登录，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          正在确认登录状态…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4 py-10 text-foreground">
        <div
          className="pointer-events-none absolute inset-0 opacity-45 dark:opacity-20"
          aria-hidden="true"
          style={{
            backgroundImage:
              'linear-gradient(to right, color-mix(in oklab, var(--border) 55%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'linear-gradient(to bottom, black, transparent 88%)',
          }}
        />
        <section className="relative w-full max-w-md border border-border bg-card p-6 shadow-sm sm:p-8">
          <img src={BRAND_LOGO_PATH} alt={BRAND_NAME} className="mb-8 h-14 w-auto" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === 'sign-in' ? '登录云梯' : '创建云梯账户'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            登录后，你生成的课程、课堂进度和素材会安全保存到自己的账户。
          </p>

          <div className="mt-6 grid grid-cols-2 border border-border p-1" aria-label="账户操作">
            <Button
              type="button"
              variant={mode === 'sign-in' ? 'default' : 'ghost'}
              className="rounded-sm"
              onClick={() => {
                setMode('sign-in');
                setError('');
                setNotice('');
              }}
            >
              登录
            </Button>
            <Button
              type="button"
              variant={mode === 'sign-up' ? 'default' : 'ghost'}
              className="rounded-sm"
              onClick={() => {
                setMode('sign-up');
                setError('');
                setNotice('');
              }}
            >
              注册
            </Button>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
            {(error || notice) && (
              <div
                ref={errorRef}
                id={feedbackId}
                tabIndex={-1}
                role={error ? 'alert' : 'status'}
                className={
                  error
                    ? 'border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive outline-none'
                    : 'border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-foreground outline-none'
                }
              >
                {error || notice}
              </div>
            )}
            <div className="space-y-2">
              <label htmlFor={emailId} className="text-sm font-medium">
                邮箱
              </label>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error || notice ? feedbackId : undefined}
                placeholder="name@example.com"
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={passwordId} className="text-sm font-medium">
                密码
              </label>
              <div className="relative">
                <Input
                  id={passwordId}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={Boolean(error) || undefined}
                  aria-describedby={error || notice ? feedbackId : undefined}
                  className="pr-10"
                  disabled={submitting}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
              {mode === 'sign-up' && (
                <p className="text-xs text-muted-foreground">
                  至少 8 个字符，支持粘贴和密码管理器。
                </p>
              )}
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {mode === 'sign-in' ? '登录' : '创建账户'}
            </Button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <>
      <div className="fixed bottom-3 right-3 z-[190] flex items-center gap-2 rounded-md border border-border bg-background/95 px-2 py-1 shadow-sm backdrop-blur">
        <span
          className="max-w-40 truncate text-xs text-muted-foreground"
          title={user.email ?? undefined}
        >
          {user.email}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="退出登录"
          title="退出登录"
          disabled={submitting}
          onClick={() => void handleSignOut()}
        >
          <LogOut aria-hidden="true" />
        </Button>
      </div>
      {children}
    </>
  );
}
