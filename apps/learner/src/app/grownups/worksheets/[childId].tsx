import { View } from 'react-native';
import { Body, Screen, Title, TopBar } from '../../../ui';

// Placeholder route: replaced by the M3.3 work package that owns this screen.
export default function Placeholder() {
  return (
    <View style={{ flex: 1 }}>
      <TopBar title="Worksheets" />
      <Screen>
        <Title>Worksheets</Title>
        <Body muted>Coming soon.</Body>
      </Screen>
    </View>
  );
}
