import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { usePathname } from 'expo-router';
import { roleLabel, visibleNav } from '../lib/roles';
import { useRuntime, useSession } from '../runtime/RuntimeProvider';
import { AppLink } from './AppLink';
import { Button } from './Button';
import {
  CONTENT_MAX_WIDTH,
  SIDEBAR_BREAKPOINT,
  SIDEBAR_WIDTH,
  colors,
  radii,
  space,
} from './theme';

interface NavEntry {
  id: string;
  label: string;
  href: string;
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ entries }: { entries: NavEntry[] }): ReactNode {
  const pathname = usePathname();
  return (
    <View accessibilityRole="navigation" accessibilityLabel="Main" style={{ gap: space[1] }}>
      {entries.map((entry) => {
        const active = isActive(pathname, entry.href);
        return (
          <View key={entry.id}>
            <AppLink
              href={entry.href as never}
              testID={`nav-${entry.id}`}
              style={{
                color: colors.sidebarText,
                textDecorationLine: 'none',
                fontWeight: active ? '800' : '500',
                fontSize: 15,
                paddingVertical: space[3],
                paddingHorizontal: space[3],
                borderRadius: radii.md,
                backgroundColor: active ? colors.sidebarActive : 'transparent',
                borderLeftWidth: 4,
                borderLeftColor: active ? colors.amber : 'transparent',
              }}
            >
              {entry.label}
            </AppLink>
          </View>
        );
      })}
    </View>
  );
}

function Account(): ReactNode {
  const { runtime, signOut } = useRuntime();
  const session = useSession();
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: colors.sidebarText, fontSize: 13 }} numberOfLines={1}>
        {session.email}
      </Text>
      <Text style={{ color: colors.sidebarText, fontSize: 12, opacity: 0.85 }}>
        {roleLabel(session.role)} · {runtime.mode === 'demo' ? 'demo data' : (runtime.host ?? 'live')}
      </Text>
      <Button label="Sign out" variant="secondary" small onPress={() => void signOut()} />
    </View>
  );
}

/** The persistent frame: a left sidebar on wide screens, a top bar with a menu on narrow ones. */
export function Shell({ children }: { children: ReactNode }): ReactNode {
  const { width } = useWindowDimensions();
  const { runtime } = useRuntime();
  const { role } = useSession();
  const [open, setOpen] = useState(false);
  const wide = width >= SIDEBAR_BREAKPOINT;
  const pathname = usePathname();

  // The narrow menu closes itself once a page has been chosen.
  useEffect(() => setOpen(false), [pathname]);

  const entries: NavEntry[] = [
    { id: 'home', label: 'Home', href: '/' },
    ...visibleNav(role).map((item) => ({ id: item.id, label: item.label, href: item.href })),
    ...(runtime.mode === 'demo' ? [{ id: 'dev', label: 'Dev: fixture preview', href: '/preview' }] : []),
  ];

  const content = (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        alignItems: 'center',
        padding: wide ? space[6] : space[4],
        paddingBottom: space[10],
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View accessibilityRole="main" style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: space[5] }}>
        {children}
      </View>
    </ScrollView>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View
          style={{
            width: SIDEBAR_WIDTH,
            backgroundColor: colors.sidebar,
            padding: space[4],
            justifyContent: 'space-between',
            gap: space[6],
          }}
        >
          <View style={{ gap: space[6] }}>
            <Brand />
            <NavLinks entries={entries} />
          </View>
          <Account />
        </View>
        {content}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ backgroundColor: colors.sidebar, padding: space[3], gap: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Brand />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? 'Close menu' : 'Open menu'}
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((value) => !value)}
            style={{
              minHeight: 40,
              justifyContent: 'center',
              paddingHorizontal: space[3],
              borderRadius: radii.md,
              borderWidth: 2,
              borderColor: colors.sidebarText,
            }}
          >
            <Text style={{ color: colors.sidebarText, fontWeight: '700' }}>{open ? 'Close' : 'Menu'}</Text>
          </Pressable>
        </View>
        {open ? (
          <View style={{ gap: space[4] }}>
            <NavLinks entries={entries} />
            <Account />
          </View>
        ) : null}
      </View>
      {content}
    </View>
  );
}

function Brand(): ReactNode {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: colors.white, fontSize: 17, fontWeight: '800' }}>CUSTAR Tutor</Text>
      <Text style={{ color: colors.sidebarText, fontSize: 12, letterSpacing: 1 }}>ADMIN · CONTENT ENGINE</Text>
    </View>
  );
}
