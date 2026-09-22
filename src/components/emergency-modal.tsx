import type { SeatVitals } from "@/components/seat-card";
import { FontSize as fontsize, Spacing as spacing, type ThemePalette } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useUserPreferences } from "@/hooks/user-preferences-context";
import { sendEmergencySms } from "@/services/sms-escalation";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { collection, getDocs } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { auth, db } from "../firebase";

interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
  hierarchy: number;
}

type Props = {
  visible: boolean;
  seat: number;
  onClose: () => void;
  id?: string;
  name: string;
  icon?: string;
  isAccountOwner?: boolean;
  vitals?: SeatVitals;
  alertAcknowledged?: boolean;
  onAcknowledgeAlert?: () => void;
  /** True only when the emergency comes from a real Main Hub fusion state (not a UAT simulation). */
  isRealEmergency?: boolean;
};

const LOCAL_EMERGENCY_CONTACTS_KEY = "app_emergency_contacts";
const HOLD_TO_CANCEL_MS = 2000;

const ROLE_LABELS: Record<number, string> = {
  1: "Driver",
  2: "Front passenger",
  3: "Left rear",
  4: "Center rear",
  5: "Right rear",
};

const formatImageUri = (value?: string) => {
  if (!value || value === "Not Set" || value.trim() === "") return undefined;
  if (value.startsWith("http") || value.startsWith("data:")) return value;
  return `data:image/jpeg;base64,${value}`;
};

export default function EmergencyModal({
  visible,
  seat,
  name,
  icon,
  onClose,
  isAccountOwner = false,
  vitals,
  alertAcknowledged = false,
  onAcknowledgeAlert,
  isRealEmergency = false,
}: Props) {
  const themes = useTheme();
  const styles = createStyles(themes);
  const isDriverSeat = seat === 1;
  const {
    emergencyEscalation,
    escalationWindowSeconds,
  } = useUserPreferences();

  const [contactMenuVisible, setContactMenuVisible] = useState(false);
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(escalationWindowSeconds);
  const [windowElapsed, setWindowElapsed] = useState(false);
  const [holdingCancel, setHoldingCancel] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smsSentRef = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!visible) {
      clearHoldTimer();
      setHoldingCancel(false);
      return;
    }

    setSecondsLeft(escalationWindowSeconds);
    setWindowElapsed(false);
    setHoldingCancel(false);
    smsSentRef.current = false;
  }, [visible, seat, escalationWindowSeconds]);

  useEffect(() => {
    if (!visible || windowElapsed || !isDriverSeat || !emergencyEscalation) return;

    const timer = setInterval(() => {
      setSecondsLeft((previous) => {
        if (previous <= 1) {
          clearInterval(timer);
          setWindowElapsed(true);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return 0;
        }
        return previous - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [visible, windowElapsed, isDriverSeat, emergencyEscalation]);

  useEffect(() => () => clearHoldTimer(), []);

  // ---- SMS escalation: fire once when the countdown elapses for driver seat ----
  useEffect(() => {
    if (!visible || !windowElapsed || !isDriverSeat || !emergencyEscalation || !isRealEmergency) return;
    if (smsSentRef.current) return;
    smsSentRef.current = true;

    void (async () => {
      try {
        const result = await sendEmergencySms({
          seatNumber: seat,
          occupantName: isAccountOwner ? "the account owner" : name,
        });
        if (result.ok) {
          if (result.skipped) {
            console.log(`SafeSeat SMS skipped: ${result.skipped}`);
          } else {
            console.log(`SafeSeat SMS sent to ${result.sentTo} (ID: ${result.messageId})`);
          }
        } else {
          console.warn("SafeSeat SMS failed:", result.error);
        }
      } catch (error) {
        console.error("SafeSeat SMS escalation error:", error);
      }
    })();
  }, [visible, windowElapsed, isDriverSeat, emergencyEscalation, isRealEmergency, seat, isAccountOwner, name]);

  // Reset the SMS sent flag when the modal closes
  useEffect(() => {
    if (!visible) {
      smsSentRef.current = false;
    }
  }, [visible]);

  const fetchEmergencyContacts = async () => {
    setLoadingContacts(true);
    let loadedContacts: EmergencyContact[] = [];

    try {
      const currentUser = auth.currentUser;
      if (currentUser) {
        const contactsRef = collection(db, "users", currentUser.uid, "emergencyContacts");
        const contactsSnap = await getDocs(contactsRef);

        loadedContacts = contactsSnap.docs.map((docSnap) => {
          const data = docSnap.data();
          const hierarchyNum = Number(data.hierarchy);
          return {
            id: docSnap.id,
            name: data.name || "Unknown contact",
            phone: data.phone || "",
            hierarchy:
              data.hierarchy != null && !Number.isNaN(hierarchyNum) && hierarchyNum > 0
                ? hierarchyNum
                : 0,
          };
        });

        loadedContacts.sort((a, b) => {
          if (a.hierarchy === 0 && b.hierarchy === 0) return 0;
          if (a.hierarchy === 0) return 1;
          if (b.hierarchy === 0) return -1;
          return a.hierarchy - b.hierarchy;
        });

        if (loadedContacts.length > 0) {
          await AsyncStorage.setItem(
            LOCAL_EMERGENCY_CONTACTS_KEY,
            JSON.stringify(loadedContacts),
          );
        }
      }

      if (loadedContacts.length === 0) {
        const cached = await AsyncStorage.getItem(LOCAL_EMERGENCY_CONTACTS_KEY);
        if (cached) loadedContacts = JSON.parse(cached);
      }

      setContacts(loadedContacts);
    } catch (error) {
      console.error("Error syncing emergency contacts:", error);
      const cached = await AsyncStorage.getItem(LOCAL_EMERGENCY_CONTACTS_KEY);
      if (cached) setContacts(JSON.parse(cached));
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleOpenContactMenu = () => {
    setContactMenuVisible(true);
    void fetchEmergencyContacts();
  };

  const handleCall = async (phoneNumber: string) => {
    const cleanNumber = phoneNumber.replace(/[^0-9+]/g, "");
    if (!cleanNumber) {
      Alert.alert("No phone number", "This contact does not have a usable phone number.");
      return;
    }

    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      const url = `tel:${cleanNumber}`;
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
      } else {
        Alert.alert("Dialer unavailable", "This device cannot open the phone dialer.");
      }
    } catch (error) {
      console.error("Failed to open phone dialer:", error);
      Alert.alert("Dialer unavailable", "Could not open the phone dialer.");
    }
  };

  const handleEmergencyServices = () => {
    Alert.alert(
      "Open emergency dialer?",
      "SafeSeat does not place automated voice calls. This only opens your phone dialer with 911 so you can choose whether to call.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open Dialer",
          style: "destructive",
          onPress: () => void handleCall("911"),
        },
      ],
    );
  };

  const handleNearbyHospitals = async () => {
    const nativeUrl = Platform.select({
      ios: "http://maps.apple.com/?q=emergency+hospital",
      android: "geo:0,0?q=emergency+hospital",
      default: "https://www.google.com/maps/search/?api=1&query=emergency+hospital",
    }) as string;

    try {
      if (await Linking.canOpenURL(nativeUrl)) {
        await Linking.openURL(nativeUrl);
      } else {
        await Linking.openURL(
          "https://www.google.com/maps/search/?api=1&query=emergency+hospital",
        );
      }
    } catch {
      Alert.alert("Maps unavailable", "Could not open nearby hospital search on this device.");
    }
  };

  const beginCancelHold = () => {
    if (holdingCancel) return;
    setHoldingCancel(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setHoldingCancel(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    }, HOLD_TO_CANCEL_MS);
  };

  const endCancelHold = () => {
    if (!holdTimerRef.current) return;
    clearHoldTimer();
    setHoldingCancel(false);
  };

  if (!visible) return null;

  const role = ROLE_LABELS[seat] ?? `Seat ${seat}`;
  const imageUri = formatImageUri(icon);
  const title = isAccountOwner
    ? "Safety event detected for you"
    : `Safety event detected for ${name}`;
  const countdownPercent = Math.max(
    0,
    Math.min(100, (secondsLeft / escalationWindowSeconds) * 100),
  );
  const driverOnlySmsEligible = isDriverSeat;

  const escalationMessage = !driverOnlySmsEligible
    ? "Passenger emergency: alert the driver. SafeSeat sound/haptics and this emergency screen remain active, but automated SMS is not triggered."
    : !emergencyEscalation
      ? "Driver Emergency SMS is turned off in Settings."
      : windowElapsed
        ? "Driver-seat escalation window elapsed. Automated SMS has been sent to the primary emergency contact."
        : "If the Driver-seat emergency remains confirmed when this timer reaches zero, automated SMS will be sent to the primary emergency contact.";

  return (
    <>
      <Modal
        animationType="fade"
        transparent
        visible={visible}
        statusBarTranslucent
        onRequestClose={() => undefined}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={styles.cardContent}
            >
            <View style={styles.topRow}>
              <View style={styles.alertPill}>
                <Ionicons name="warning" color={themes.warnBttn} size={15} />
                <Text style={styles.alertPillText}>EMERGENCY</Text>
              </View>
              {driverOnlySmsEligible && emergencyEscalation ? <Text style={styles.timerValue}>{windowElapsed ? "00" : String(secondsLeft).padStart(2, "0")}s</Text> : <Text style={styles.passengerAlertText}>{driverOnlySmsEligible ? "SMS OFF" : "DRIVER ALERT"}</Text>}
            </View>

            {driverOnlySmsEligible && emergencyEscalation ? (
              <View style={styles.timerTrack}>
                <View style={[styles.timerFill, { width: `${countdownPercent}%` }]} />
              </View>
            ) : null}

            <View style={styles.headerRow}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={styles.avatar} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarLetter}>{name.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              <View style={styles.headerCopy}>
                <Text style={styles.titleText}>{title}</Text>
                <Text style={styles.subtitleText}>{role} · sustained abnormal pattern</Text>
              </View>
            </View>

            <View style={styles.vitalsBox}>
              <View style={styles.vitalsHeader}>
                <Text style={styles.vitalsTitle}>VITAL SIGNS</Text>
                <View style={[styles.vitalsStatus, vitals?.trusted && styles.vitalsStatusLive]}>
                  <Text style={[styles.vitalsStatusText, vitals?.trusted && styles.vitalsStatusTextLive]}>
                    {vitals?.trusted ? "LIVE" : vitals?.statusLabel === "UNAVAILABLE" ? "UNAVAILABLE" : "REACQUIRING"}
                  </Text>
                </View>
              </View>
              {vitals?.trusted ? (
                <View style={styles.vitalsValues}>
                  <View style={styles.vitalTile}>
                    <Text style={styles.vitalAbbr}>HR</Text>
                    <Text style={styles.vitalNumber}>{vitals.heartRateBpm ?? "—"}</Text>
                    <Text style={styles.vitalUnit}>bpm</Text>
                  </View>
                  <View style={styles.vitalTile}>
                    <Text style={styles.vitalAbbr}>RR</Text>
                    <Text style={styles.vitalNumber}>{vitals.respirationRateBpm ?? "—"}</Text>
                    <Text style={styles.vitalUnit}>/min</Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.vitalsUnavailable}>SafeSeat is reacquiring a trustworthy heart-rate and breathing signal.</Text>
              )}
            </View>

            <View style={styles.summaryBox}>
              <Text style={styles.summaryLabel}>ALERT CATEGORY</Text>
              <Text style={styles.summaryTitle}>Abnormal multi-sensor pattern</Text>
              <Text style={styles.summaryText}>
                SafeSeat is advisory and does not diagnose a medical condition. Verify the occupant and respond to the situation around you.
              </Text>
            </View>

            <View style={styles.escalationBox}>
              <View style={styles.escalationHeader}>
                <Ionicons
                  name={driverOnlySmsEligible && emergencyEscalation ? "chatbubble-ellipses" : "information-circle"}
                  color={themes.primaryBttn}
                  size={18}
                />
                <Text style={styles.escalationTitle}>{driverOnlySmsEligible ? "Driver Emergency SMS" : "Driver Alert"}</Text>
              </View>
              <Text style={styles.escalationText}>{escalationMessage}</Text>
            </View>

            <View style={styles.quickActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void handleNearbyHospitals()}
                style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}
              >
                <Ionicons name="map" color={themes.primaryBttn} size={20} />
                <Text style={styles.quickActionText}>Nearby hospitals</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={handleOpenContactMenu}
                style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}
              >
                <Ionicons name="people" color={themes.primaryBttn} size={20} />
                <Text style={styles.quickActionText}>Contacts</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={handleEmergencyServices}
                style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}
              >
                <Ionicons name="call" color={themes.warnBttn} size={20} />
                <Text style={styles.quickActionText}>Dialer</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Acknowledge emergency alert sound"
              disabled={alertAcknowledged}
              onPress={onAcknowledgeAlert}
              style={({ pressed }) => [
                styles.acknowledgeButton,
                alertAcknowledged && styles.acknowledgeButtonDone,
                pressed && !alertAcknowledged && styles.pressed,
              ]}
            >
              <Ionicons name={alertAcknowledged ? "checkmark-circle" : "volume-high"} color={alertAcknowledged ? themes.green : themes.text} size={21} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.acknowledgeTitle, alertAcknowledged && { color: themes.green }]}>
                  {alertAcknowledged ? "Alert acknowledged" : "Acknowledge Alert"}
                </Text>
                <Text style={styles.acknowledgeHint}>
                  {alertAcknowledged ? "Sound stopped. Emergency monitoring continues." : "Stops the repeating sound only. Emergency monitoring stays active."}
                </Text>
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold for two seconds to cancel emergency"
              onPressIn={beginCancelHold}
              onPressOut={endCancelHold}
              style={({ pressed }) => [
                styles.cancelHold,
                holdingCancel && styles.cancelHoldActive,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons
                name={holdingCancel ? "hand-left" : "close-circle-outline"}
                color={holdingCancel ? themes.primaryBttnText : themes.text}
                size={21}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.cancelHoldTitle,
                    holdingCancel && { color: themes.primaryBttnText },
                  ]}
                >
                  {holdingCancel ? "Keep holding…" : "Hold 2 seconds to cancel"}
                </Text>
                <Text
                  style={[
                    styles.cancelHoldHint,
                    holdingCancel && { color: themes.primaryBttnText },
                  ]}
                >
                  Use only after verifying the alert is a false alarm or the occupant has recovered.
                </Text>
              </View>
            </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        transparent
        visible={contactMenuVisible}
        onRequestClose={() => setContactMenuVisible(false)}
      >
        <View style={styles.contactBackdrop}>
          <View style={styles.contactSheet}>
            <View style={styles.contactHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.contactTitle}>Emergency Contacts</Text>
                <Text style={styles.contactSubtitle}>
                  These are manual dialer shortcuts. Automated SMS escalation runs in the background when the driver emergency countdown elapses.
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close emergency contacts"
                onPress={() => setContactMenuVisible(false)}
                style={styles.closeButton}
              >
                <Ionicons name="close" color={themes.text} size={24} />
              </Pressable>
            </View>

            {loadingContacts ? (
              <ActivityIndicator size="large" color={themes.primaryBttn} style={styles.loader} />
            ) : contacts.length > 0 ? (
              <ScrollView style={styles.contactList} contentContainerStyle={styles.contactListContent}>
                {contacts.map((contact) => (
                  <Pressable
                    key={contact.id}
                    onPress={() => void handleCall(contact.phone)}
                    style={({ pressed }) => [styles.contactRow, pressed && styles.contactRowPressed]}
                  >
                    <View style={styles.contactIcon}>
                      <Ionicons name="call" color={themes.primaryBttn} size={20} />
                    </View>
                    <View style={styles.contactCopy}>
                      <Text style={styles.contactName}>{contact.name}</Text>
                      <Text style={styles.contactPhone}>{contact.phone || "No phone number"}</Text>
                    </View>
                    <Text style={styles.contactOrder}>
                      {contact.hierarchy > 0 ? `${contact.hierarchy}${contact.hierarchy === 1 ? "st" : contact.hierarchy === 2 ? "nd" : contact.hierarchy === 3 ? "rd" : "th"}` : ""}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <View style={styles.emptyContacts}>
                <Ionicons name="person-add-outline" color={themes.textSecondary} size={34} />
                <Text style={styles.emptyContactsTitle}>No emergency contacts yet</Text>
                <Text style={styles.emptyContactsText}>Add contacts from Profiles → Emergency Contacts.</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const createStyles = (themes: ThemePalette) => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.two,
    backgroundColor: themes.overlay,
  },
  card: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "92%",
    alignSelf: "center",
    borderRadius: 26,
    backgroundColor: themes.backgroundElement,
    borderWidth: 1,
    borderColor: `${themes.warnBttn}55`,
    overflow: "hidden",
  },
  cardContent: {
    gap: spacing.two,
    padding: spacing.two,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  alertPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.half,
    paddingHorizontal: spacing.one,
    paddingVertical: spacing.half,
    borderRadius: 999,
    backgroundColor: `${themes.warnBttn}16`,
    borderWidth: 1,
    borderColor: `${themes.warnBttn}55`,
  },
  alertPillText: {
    color: themes.warnBttn,
    fontSize: 10,
    letterSpacing: 1.2,
    fontFamily: "Body-Bold",
  },
  timerValue: {
    color: themes.warnBttn,
    fontSize: 24,
    fontFamily: "Body-Bold",
  },
  passengerAlertText: { color: themes.textSecondary, fontSize: 12, letterSpacing: 0.7, fontFamily: "Body-Bold" },
  timerTrack: {
    height: 5,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: themes.secondaryBttn,
  },
  timerFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: themes.warnBttn,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.two,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: themes.warnBttn,
  },
  avatarFallback: {
    width: 60,
    height: 60,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: themes.warnBttn,
    backgroundColor: themes.backgroundElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: {
    color: themes.text,
    fontSize: fontsize.header,
    fontFamily: "Body-Bold",
  },
  headerCopy: {
    flex: 1,
    gap: spacing.half,
  },
  titleText: {
    color: themes.text,
    fontSize: 19,
    lineHeight: 23,
    fontFamily: "Body-Bold",
  },
  subtitleText: {
    color: themes.textSecondary,
    fontSize: fontsize.caption,
    fontFamily: "Body-Regular",
  },
  vitalsBox: {
    padding: spacing.one + 4,
    borderRadius: 18,
    backgroundColor: "rgba(52, 209, 127, 0.055)",
    borderWidth: 1,
    borderColor: "rgba(52, 209, 127, 0.20)",
    gap: spacing.one,
  },
  vitalsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  vitalsTitle: { color: themes.textSecondary, fontSize: 10, letterSpacing: 1.1, fontFamily: "Body-Bold" },
  vitalsStatus: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: themes.surfaceSoft, borderWidth: 1, borderColor: themes.divider },
  vitalsStatusLive: { backgroundColor: "rgba(52, 209, 127, 0.10)", borderColor: themes.primaryBorder },
  vitalsStatusText: { color: themes.textMuted, fontSize: 8, letterSpacing: 0.7, fontFamily: "Body-Bold" },
  vitalsStatusTextLive: { color: themes.green },
  vitalsValues: { flexDirection: "row", gap: spacing.one },
  vitalTile: { flex: 1, minHeight: 66, borderRadius: 15, paddingHorizontal: spacing.one, alignItems: "center", justifyContent: "center", backgroundColor: themes.backgroundElevated, borderWidth: 1, borderColor: themes.divider },
  vitalAbbr: { color: themes.textMuted, fontSize: 9, letterSpacing: 0.8, fontFamily: "Body-Bold" },
  vitalNumber: { color: themes.text, fontSize: 23, lineHeight: 27, fontFamily: "Body-Bold", marginTop: 1 },
  vitalUnit: { color: themes.textSecondary, fontSize: 9, fontFamily: "Body-Medium" },
  vitalsUnavailable: { color: themes.textSecondary, fontSize: fontsize.caption, lineHeight: 17, fontFamily: "Body-Regular" },
  summaryBox: {
    padding: spacing.two,
    borderRadius: 18,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  summaryLabel: {
    color: themes.warnBttn,
    fontSize: 10,
    letterSpacing: 1.1,
    fontFamily: "Body-Bold",
  },
  summaryTitle: {
    color: themes.text,
    fontSize: 15,
    marginTop: spacing.half,
    fontFamily: "Body-Bold",
  },
  summaryText: {
    color: themes.textSecondary,
    fontSize: fontsize.caption,
    lineHeight: 18,
    marginTop: spacing.half,
    fontFamily: "Body-Regular",
  },
  escalationBox: {
    padding: spacing.one + 4,
    borderRadius: 16,
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  escalationHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.half,
  },
  escalationTitle: {
    color: themes.primaryBttn,
    fontSize: 13,
    fontFamily: "Body-Bold",
  },
  escalationText: {
    color: themes.text,
    fontSize: fontsize.caption,
    lineHeight: 18,
    marginTop: spacing.half,
    fontFamily: "Body-Regular",
  },
  locationText: {
    color: themes.textSecondary,
    fontSize: 10,
    marginTop: spacing.half,
    fontFamily: "Body-Medium",
  },
  quickActions: {
    flexDirection: "row",
    gap: spacing.one,
  },
  quickAction: {
    flex: 1,
    minHeight: 64,
    paddingHorizontal: spacing.half,
    paddingVertical: spacing.one,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.half,
    backgroundColor: themes.backgroundElevated,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  quickActionText: {
    color: themes.text,
    fontSize: 10,
    textAlign: "center",
    fontFamily: "Body-Bold",
  },
  acknowledgeButton: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.one,
    paddingHorizontal: spacing.one + 4,
    paddingVertical: spacing.one,
    borderRadius: 18,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  acknowledgeButtonDone: { backgroundColor: "rgba(52, 209, 127, 0.06)", borderColor: themes.primaryBorder },
  acknowledgeTitle: { color: themes.text, fontSize: 14, fontFamily: "Body-Bold" },
  acknowledgeHint: { color: themes.textSecondary, fontSize: 9.5, lineHeight: 13, marginTop: 2, fontFamily: "Body-Regular" },
  cancelHold: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.one,
    padding: spacing.one + 4,
    borderRadius: 18,
    backgroundColor: themes.secondaryBttn,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  cancelHoldActive: {
    backgroundColor: themes.primaryBttn,
    borderColor: themes.primaryBttn,
  },
  cancelHoldTitle: {
    color: themes.text,
    fontSize: 14,
    fontFamily: "Body-Bold",
  },
  cancelHoldHint: {
    color: themes.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
    fontFamily: "Body-Regular",
  },
  pressed: {
    opacity: 0.76,
    transform: [{ scale: 0.99 }],
  },
  contactBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: themes.overlay,
  },
  contactSheet: {
    maxHeight: "72%",
    padding: spacing.two,
    paddingBottom: spacing.four,
    gap: spacing.two,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: themes.backgroundElement,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  contactHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.two,
  },
  contactTitle: {
    color: themes.text,
    fontSize: fontsize.header,
    fontFamily: "Heading-Font",
  },
  contactSubtitle: {
    color: themes.textSecondary,
    fontSize: fontsize.caption,
    lineHeight: 17,
    fontFamily: "Body-Regular",
    marginTop: spacing.half,
  },
  closeButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: themes.backgroundElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  loader: {
    marginVertical: spacing.four,
  },
  contactList: {
    width: "100%",
  },
  contactListContent: {
    gap: spacing.one,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.one,
    padding: spacing.two,
    borderRadius: 16,
    backgroundColor: themes.backgroundElevated,
  },
  contactRowPressed: {
    opacity: 0.7,
  },
  contactIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: themes.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  contactCopy: {
    flex: 1,
  },
  contactName: {
    color: themes.text,
    fontSize: fontsize.body,
    fontFamily: "Body-Bold",
  },
  contactPhone: {
    color: themes.textSecondary,
    fontSize: fontsize.caption,
    fontFamily: "Body-Regular",
    marginTop: spacing.quarter,
  },
  contactOrder: {
    color: themes.primaryBttn,
    fontSize: fontsize.caption,
    fontFamily: "Body-Bold",
  },
  emptyContacts: {
    alignItems: "center",
    paddingVertical: spacing.four,
    gap: spacing.one,
  },
  emptyContactsTitle: {
    color: themes.text,
    fontSize: fontsize.body,
    fontFamily: "Body-Bold",
  },
  emptyContactsText: {
    color: themes.textSecondary,
    fontSize: fontsize.caption,
    textAlign: "center",
    fontFamily: "Body-Regular",
  },
});
