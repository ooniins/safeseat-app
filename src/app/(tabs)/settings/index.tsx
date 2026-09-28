import { FontSize as fontsize, Spacing as spacing, type ThemePalette } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useUserPreferences } from "@/hooks/user-preferences-context";
import { useSafeSeatHub } from "@/hooks/safeseat-hub-context";
import { useDriverGuide } from "@/hooks/driver-guide-context";
import { clearSession } from "@/utils/securitySession";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useCallback, useRef, useState } from "react";
import { Alert, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";


import ChangePasswordModal from "@/components/change-password-modal";
import ChangePhoneModal from "@/components/change-phone-modal";
import EscalationWindowControl from "@/components/escalation-window-control";
import SettingPageItem from "@/components/setting-page-item";
import SettingSwitch from "@/components/setting-switch";
import { sendEmergencySms } from "@/services/sms-escalation";
import { auth, db } from "../../../firebase";

const IS_LOCKED_IN_KEY = "isLockedIn";
const SEAT_ASSIGNMENTS_KEY = "seatAssignments";
const SEAT_STATUSES_KEY = "seatStatuses";
const HARDWARE_SEAT_KEY = "safeSeatHardwareSeatNo";
const SEAT_CONSENTS_KEY = "seatSessionConsents";

type SectionKey = "account" | "alerts" | "system";

export default function Settings() {
  const themes = useTheme();
  const styles = createStyles(themes);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Record<SectionKey, number>>({ account: 0, alerts: 0, system: 0 });
  const sectionsStartY = useRef(0);
  const stickyHeight = useRef(62);
  const bottomPad = 100 + insets.bottom;
  const { connected: hubConnected, telemetryReady } = useSafeSeatHub();
  const { startGuide } = useDriverGuide();

  const [userEmail, setUserEmail] = useState("Not set");
  const [userPhone, setUserPhone] = useState("Not set");
  const [isLockedIn, setIsLockedIn] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>("account");
  const [changePhoneVisible, setChangePhoneVisible] = useState(false);
  const [changePassVisible, setChangePassVisible] = useState(false);
  const [testingSms, setTestingSms] = useState(false);

  const {
    emergencyEscalation, setEmergencyEscalation,
    escalationWindowSeconds, setEscalationWindowSeconds,
    useMetric, setUseMetric,
    themeMode, setThemeMode,
    prototypeIndicator, setPrototypeIndicator, loading: preferencesLoading,
  } = useUserPreferences();

  const loadAllUserData = useCallback(async () => {
    try {
      const rawLockedIn = await AsyncStorage.getItem(IS_LOCKED_IN_KEY);
      setIsLockedIn(rawLockedIn ? JSON.parse(rawLockedIn) : false);
      const currentUser = auth.currentUser;
      if (!currentUser) return;
      setUserEmail(currentUser.email ?? "Not set");
      const snap = await getDoc(doc(db, "users", currentUser.uid));
      if (snap.exists()) {
        const data = snap.data();
        if (data.phone) setUserPhone(data.phone);
      }
    } catch (error) {
      console.error("Failed to load Settings data:", error);
    }
  }, []);

  useFocusEffect(useCallback(() => { void loadAllUserData(); }, [loadAllUserData]));

  const scrollTo = (key: SectionKey) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    setActiveSection(key);
    const target = sectionsStartY.current + sectionY.current[key] - stickyHeight.current - 10;
    scrollRef.current?.scrollTo({ y: Math.max(0, target), animated: true });
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const localY = event.nativeEvent.contentOffset.y + stickyHeight.current + 22 - sectionsStartY.current;
    const systemY = sectionY.current.system;
    const alertsY = sectionY.current.alerts;
    if (localY >= systemY - 18) setActiveSection("system");
    else if (localY >= alertsY - 18) setActiveSection("alerts");
    else setActiveSection("account");
  };

  const clearSeatAssignments = () => {
    if (isLockedIn) return;
    Alert.alert("Clear seat assignments?", "This clears the current seat setup. Saved profiles and emergency contacts stay intact.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: async () => {
        try {
          await AsyncStorage.multiRemove([SEAT_ASSIGNMENTS_KEY, SEAT_STATUSES_KEY, IS_LOCKED_IN_KEY, HARDWARE_SEAT_KEY, SEAT_CONSENTS_KEY]);
          setIsLockedIn(false);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Cleared", "Seat assignments were reset.");
        } catch {
          Alert.alert("Could not clear", "Please try again.");
        }
      } },
    ]);
  };

  const handleLogout = () => {
    if (isLockedIn) return;
    Alert.alert("Log out?", "Local trip data on this device will be cleared.", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: async () => {
        try {
          await signOut(auth);
          await clearSession();
          await AsyncStorage.multiRemove([SEAT_ASSIGNMENTS_KEY, SEAT_STATUSES_KEY, IS_LOCKED_IN_KEY, HARDWARE_SEAT_KEY, SEAT_CONSENTS_KEY, "app_emergency_contacts", "userPreferences"]);
          await Promise.all([
            SecureStore.deleteItemAsync("user_health_profile"),
            SecureStore.deleteItemAsync("user_privacy_prefs"),
            SecureStore.deleteItemAsync("user_local_app_prefs"),
            SecureStore.deleteItemAsync("is_logged_in"),
          ]);
          router.replace("/(auth)/login");
        } catch {
          Alert.alert("Log out failed", "Please try again.");
        }
      } },
    ]);
  };

  const runSmsBackendTest = async () => {
    if (testingSms) return;

    setTestingSms(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const result = await sendEmergencySms({
        seatNumber: 1,
        occupantName: "SafeSeat Test Driver",
      });

      if (!result.ok) {
        Alert.alert(
          "SMS test failed",
          result.error,
        );
        return;
      }

      if (result.skipped === "test_mode") {
        Alert.alert(
          "Backend test successful",
          "The app authenticated with Firebase and reached the SMS backend. Vercel TEST_MODE is ON, so no real SMS was sent.",
        );
        return;
      }

      if (result.skipped === "no_contacts") {
        Alert.alert(
          "No emergency contacts",
          "Add at least one emergency contact before testing SMS delivery.",
        );
        return;
      }

      if (result.skipped === "no_phone_number") {
        Alert.alert(
          "No usable phone number",
          "The highest-priority emergency contact does not have a usable phone number.",
        );
        return;
      }

      if (result.skipped === "duplicate_event") {
        Alert.alert(
          "Duplicate test ignored",
          "The backend correctly ignored a duplicate emergency event.",
        );
        return;
      }

      Alert.alert(
        "SMS request accepted",
        result.sentTo
          ? `Infobip accepted the emergency SMS for ${result.sentTo}.${result.messageId ? `\n\nMessage ID: ${result.messageId}` : ""}`
          : "The SMS backend completed successfully.",
      );
    } catch (error) {
      Alert.alert(
        "SMS test failed",
        error instanceof Error ? error.message : "Unexpected error while testing the SMS backend.",
      );
    } finally {
      setTestingSms(false);
    }
  };

  const handleSmsBackendTest = () => {
    Alert.alert(
      "Test Emergency SMS",
      "This is a temporary developer test. If Vercel TEST_MODE is OFF, this can send a real SMS to your highest-priority emergency contact. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Run test", onPress: () => void runSmsBackendTest() },
      ],
    );
  };

  const shortcut = (label: string, key: SectionKey) => {
    const selected = activeSection === key;
    return (
      <Pressable
        onPress={() => scrollTo(key)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        style={({ pressed }) => [styles.shortcut, selected && styles.shortcutActive, pressed && styles.pressed]}
      >
        <Text style={[styles.shortcutText, selected && styles.shortcutTextActive]} numberOfLines={1}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]}
        onScroll={handleScroll}
        scrollEventThrottle={32}
      >
        <View style={styles.headerShell}>
          <View style={styles.headerBlock}>
            <Text style={styles.eyebrow}>PREFERENCES</Text>
            <Text style={styles.pageHeader}>Settings</Text>
            <Text style={styles.pageSubhead}>Account, alerts, display, and SafeSeat tools.</Text>
          </View>
        </View>

        <View
          style={styles.stickyShortcutShell}
          onLayout={(event) => { stickyHeight.current = event.nativeEvent.layout.height; }}
        >
          <View style={styles.shortcutDock}>
            {shortcut("Account", "account")}
            {shortcut("Alerts", "alerts")}
            {shortcut("System", "system")}
          </View>
        </View>

        <View
          style={styles.sectionsContainer}
          onLayout={(event) => { sectionsStartY.current = event.nativeEvent.layout.y; }}
        >
          <View onLayout={(e) => { sectionY.current.account = e.nativeEvent.layout.y; }} style={styles.section}>
            <Text style={styles.sectionTitle}>ACCOUNT</Text>
            <View style={styles.settingGroup}>
              <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }} accessible accessibilityLabel={`Email, ${userEmail}`}><Text style={styles.infoTitle}>Email</Text><Text selectable style={styles.infoCopy}>{userEmail}</Text></View>
              <SettingPageItem name="Phone" iconName="call-outline" value={userPhone} onPress={() => setChangePhoneVisible(true)} showChevron />
              <SettingPageItem name="Password" iconName="key-outline" onPress={() => setChangePassVisible(true)} showChevron isLast />
            </View>
          </View>

          <View onLayout={(e) => { sectionY.current.alerts = e.nativeEvent.layout.y; }} style={styles.section}>
            <Text style={styles.sectionTitle}>ALERTS & EMERGENCY</Text>


            <View style={styles.settingGroup}>
              <SettingSwitch name="Driver Emergency SMS" iconName="chatbubble-ellipses-outline" value={emergencyEscalation} onValueChange={(v) => void setEmergencyEscalation(v)} isLast />
            </View>
            <Text style={styles.note}>SMS applies to Driver emergencies only.</Text>
            <EscalationWindowControl value={escalationWindowSeconds} enabled={emergencyEscalation} onValueChange={(v) => void setEscalationWindowSeconds(v)} />
            <View style={styles.settingGroup}>
              <SettingPageItem name="Profiles & Emergency Contacts" iconName="people-outline" onPress={() => router.push("/(tabs)/everyone" as any)} showChevron isLast />
            </View>
            <View style={styles.settingGroup}>
              <SettingPageItem
                name="Test Emergency SMS"
                iconName="flask-outline"
                value={testingSms ? "Testing…" : "Developer test"}
                enabled={!testingSms}
                onPress={handleSmsBackendTest}
                showChevron
                isLast
              />
            </View>
            <Text style={styles.note}>Temporary test control. Remove before the final release. Vercel TEST_MODE decides whether the request is simulated or actually sent.</Text>
          </View>

          <View onLayout={(e) => { sectionY.current.system = e.nativeEvent.layout.y; }} style={styles.section}>
            <Text style={styles.sectionTitle}>SYSTEM & DISPLAY</Text>
            <View style={styles.settingGroup}>
              <SettingSwitch name="Light Mode" iconName="sunny-outline" value={themeMode === "light"} onValueChange={(v) => void setThemeMode(v ? "light" : "dark")} />
              <SettingSwitch name="Use Metric Units" iconName="speedometer-outline" value={useMetric} onValueChange={(v) => void setUseMetric(v)} isLast />
            </View>

            <View style={styles.settingGroup}>
              <SettingSwitch name="Sensor setup card" iconName="hardware-chip-outline" value={prototypeIndicator} enabled={!preferencesLoading} onValueChange={(v) => {
                void setPrototypeIndicator(v).catch(() => Alert.alert("Could not save setting", "Please try again before closing the app."));
              }} isLast />
            </View>

            <View style={styles.settingGroup}>
              <SettingPageItem name="System Diagnostic" iconName="pulse-outline" value={hubConnected ? (telemetryReady ? "Live" : "Warming") : "Offline"} onPress={() => router.push("/(tabs)/settings/diagnostics" as any)} showChevron />
              <SettingPageItem name="SafeSeat Guide" iconName="help-circle-outline" value={isLockedIn ? "After session" : "Replay"} onPress={() => {
                if (isLockedIn) {
                  Alert.alert("Guide unavailable during monitoring", "End monitoring before replaying the guide.");
                  return;
                }
                startGuide();
              }} showChevron />
              <SettingPageItem name="Quick Help" iconName="book-outline" onPress={() => router.push("/(tabs)/settings/help" as any)} showChevron isLast />
            </View>

            <Text style={styles.sectionTitle}>SESSION & ACCOUNT</Text>
            <View style={styles.settingGroup}>
              <SettingPageItem name="Clear Seat Assignments" iconName="trash-outline" enabled={!isLockedIn} onPress={clearSeatAssignments} />
              <SettingPageItem name="Log out" iconName="log-out-outline" enabled={!isLockedIn} destructive onPress={handleLogout} isLast />
            </View>
            {isLockedIn ? <Text style={styles.note}>End the active monitoring session before clearing assignments or logging out.</Text> : null}
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerBrand}>SafeSeat</Text>
            <Text style={styles.footerCopy}>Non-diagnostic occupant safety monitoring</Text>
          </View>
        </View>
      </ScrollView>

      <ChangePhoneModal visible={changePhoneVisible} onClose={() => setChangePhoneVisible(false)} onSuccess={() => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setChangePhoneVisible(false); void loadAllUserData(); }} />
      <ChangePasswordModal visible={changePassVisible} onClose={() => setChangePassVisible(false)} onSuccess={() => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setChangePassVisible(false); void loadAllUserData(); }} />
    </SafeAreaView>
  );
}

const createStyles = (themes: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: themes.background },
  scrollContent: { flexGrow: 1 },
  headerShell: { paddingHorizontal: spacing.two, paddingTop: spacing.one, paddingBottom: 10, backgroundColor: themes.background },
  headerBlock: { gap: 3 },
  eyebrow: { color: themes.primaryBttn, fontSize: 11, letterSpacing: 1.4, fontFamily: "Body-Bold" },
  pageHeader: { fontSize: fontsize.pageHeader, fontFamily: "Logo-Font", color: themes.text },
  pageSubhead: { color: themes.textSecondary, fontSize: fontsize.body, lineHeight: 21, fontFamily: "Body-Regular" },

  stickyShortcutShell: {
    zIndex: 50,
    elevation: 20,
    backgroundColor: themes.background,
    paddingHorizontal: spacing.two,
    paddingTop: 5,
    paddingBottom: 9,
  },
  shortcutDock: {
    flexDirection: "row",
    gap: 6,
    padding: 5,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: themes.divider,
    backgroundColor: themes.backgroundElevated,
    shadowColor: themes.shadow,
    shadowOpacity: themes.mode === "dark" ? 0.24 : 0.09,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 7,
  },
  shortcut: {
    flex: 1,
    minHeight: 38,
    paddingHorizontal: 8,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  shortcutActive: {
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  shortcutText: { color: themes.textSecondary, fontSize: 12.5, lineHeight: 17, textAlign: "center", fontFamily: "Body-Bold" },
  shortcutTextActive: { color: themes.primaryBttn },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },

  sectionsContainer: { paddingHorizontal: spacing.two, gap: spacing.three },
  section: { gap: 10 },
  sectionTitle: { color: themes.textMuted, fontFamily: "Body-Bold", fontSize: 11.5, letterSpacing: 1.1, marginLeft: 4, marginTop: 4 },
  settingGroup: { borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: themes.divider, backgroundColor: themes.backgroundElement },
  infoCard: { flexDirection: "row", gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: themes.primaryBorder, backgroundColor: themes.primarySoft },
  infoIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: themes.backgroundElement, alignItems: "center", justifyContent: "center" },
  infoTitle: { color: themes.text, fontSize: 15.5, lineHeight: 21, fontFamily: "Body-Bold" },
  infoCopy: { color: themes.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: "Body-Regular", marginTop: 3 },
  note: { color: themes.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: "Body-Regular", paddingHorizontal: 4 },
  noteStrong: { color: themes.text, fontFamily: "Body-Bold" },
  footer: { alignItems: "center", paddingVertical: 24, gap: 4 },
  footerBrand: { color: themes.text, fontFamily: "Logo-Font", fontSize: 22 },
  footerCopy: { color: themes.textMuted, fontSize: 12, fontFamily: "Body-Regular" },
});
