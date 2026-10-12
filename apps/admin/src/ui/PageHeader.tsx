import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Href } from 'expo-router';
import { AppLink } from './AppLink';
import { H1, P } from './Text';
import { colors, space } from './theme';

export interface Crumb {
  label: string;
  href?: Href;
}

/** Breadcrumbs, the page title, a line of context and the page's main actions. */
export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
  badges,
}: {
  title: string;
  subtitle?: string | undefined;
  crumbs?: Crumb[];
  actions?: ReactNode;
  badges?: ReactNode;
}): ReactNode {
  return (
    <View style={{ gap: space[2] }}>
      {crumbs && crumbs.length > 0 ? (
        <View
          role="navigation"
          accessibilityLabel="Breadcrumb"
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}
        >
          {crumbs.map((crumb, index) => (
            <View key={`${crumb.label}-${index}`} style={{ flexDirection: 'row', gap: space[2] }}>
              {crumb.href ? (
                <AppLink href={crumb.href} style={{ fontSize: 13 }}>
                  {crumb.label}
                </AppLink>
              ) : (
                <Text style={{ fontSize: 13, color: colors.subtle }}>{crumb.label}</Text>
              )}
              {index < crumbs.length - 1 ? (
                <Text aria-hidden style={{ fontSize: 13, color: colors.subtle }}>
                  ›
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: space[4],
          flexWrap: 'wrap',
        }}
      >
        <View style={{ flexShrink: 1, gap: space[1], minWidth: 240 }}>
          <H1>{title}</H1>
          {subtitle ? <P style={{ color: colors.subtle }}>{subtitle}</P> : null}
          {badges ? (
            <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>{badges}</View>
          ) : null}
        </View>
        {actions ? (
          <View style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap' }}>{actions}</View>
        ) : null}
      </View>
    </View>
  );
}
