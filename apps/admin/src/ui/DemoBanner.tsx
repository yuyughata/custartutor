import type { ReactNode } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from '../lib/roles';
import { Select } from './Select';
import { colors, space } from './theme';

export const DEMO_BANNER_TEXT = 'DEMO: sample data and a stand-in model, not Claude';

/**
 * The permanent demo banner. It is rendered above every screen, signed in or not, and cannot be dismissed.
 * It also carries the demo-only role switcher, which shows how buttons change per role.
 */
export function DemoBanner({
  role,
  onRoleChange,
}: {
  /** The signed-in demo role, or null before sign-in. */
  role: AdminRole | null;
  onRoleChange?: ((role: AdminRole) => void) | undefined;
}): ReactNode {
  const { width } = useWindowDimensions();
  return (
    <View
      accessibilityRole="alert"
      testID="demo-banner"
      style={{
        backgroundColor: colors.amberText,
        paddingHorizontal: space[4],
        paddingVertical: space[2],
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: space[2],
        borderBottomWidth: 3,
        borderBottomColor: colors.amber,
      }}
    >
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={{ color: colors.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 }}>
          {DEMO_BANNER_TEXT}
        </Text>
        {width >= 600 ? (
          <Text style={{ color: '#fbf1e4', fontSize: 12, lineHeight: 16 }}>
            Nothing is saved or sent anywhere. Reloading the page starts over.
          </Text>
        ) : null}
      </View>
      {role && onRoleChange ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text style={{ color: '#fbf1e4', fontSize: 12 }}>Demo role</Text>
          <Select
            label="Demo role"
            hideLabel
            value={role}
            options={ADMIN_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
            onChange={(role) => {
              const next = ADMIN_ROLES.find((candidate) => candidate === role);
              if (next) onRoleChange(next);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
