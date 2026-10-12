import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GrownupGate } from '../../../helper/GrownupGate';
import { TopBar } from '../../../ui';
import { WorksheetsScreen } from '../../../worksheets/WorksheetsScreen';

/** Grown-ups area: printable worksheets of a child's downloaded lessons. Re-asks the PIN if the elevation has lapsed. */
export default function WorksheetsRoute() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  return (
    <View style={{ flex: 1 }}>
      <TopBar title="Worksheets" />
      <GrownupGate title="Grown-ups only" body="Enter your PIN to open the worksheets.">
        <WorksheetsScreen childId={childId} />
      </GrownupGate>
    </View>
  );
}
