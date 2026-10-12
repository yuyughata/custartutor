import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Button, type ButtonVariant } from './Button';
import { H2, P } from './Text';
import { colors, radii, space } from './theme';

/** A modal confirmation: a title, some words, and a clear choice. Nothing happens until a button is pressed. */
export function ConfirmDialog({
  visible,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        accessibilityLabel="Close dialog"
        onPress={busy ? undefined : onCancel}
        style={{
          flex: 1,
          backgroundColor: 'rgba(20, 30, 30, 0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: space[4],
        }}
      >
        <Pressable
          accessibilityRole="alert"
          aria-modal
          onPress={() => undefined}
          style={{
            width: '100%',
            maxWidth: 520,
            maxHeight: '90%',
            backgroundColor: colors.white,
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          <ScrollView contentContainerStyle={{ padding: space[5], gap: space[3] }}>
            <H2>{title}</H2>
            {typeof children === 'string' ? <P>{children}</P> : children}
            <View
              style={{ flexDirection: 'row', gap: space[3], flexWrap: 'wrap', marginTop: space[2] }}
            >
              <Button
                label={confirmLabel}
                onPress={onConfirm}
                variant={confirmVariant}
                busy={busy}
              />
              <Button label={cancelLabel} onPress={onCancel} variant="secondary" disabled={busy} />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
