import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GrownupGate } from '../../../helper/GrownupGate';
import { HelperLauncher } from '../../../helper/HelperLauncher';
import { TopBar } from '../../../ui';

/** Grown-ups area: start a helper session for a child. Re-asks the PIN if the grown-up elevation has lapsed. */
export default function HelperLauncherRoute() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  return (
    <View style={{ flex: 1 }}>
      <TopBar title="Helper mode" />
      <GrownupGate title="Grown-ups only" body="Enter your PIN to start a helper session.">
        <HelperLauncher childId={childId} />
      </GrownupGate>
    </View>
  );
}
