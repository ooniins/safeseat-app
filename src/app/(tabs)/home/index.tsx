import ThemedHost from "@/components/themed-host";
import EmergencyModal from "@/components/emergency-modal";
import { SeatVitals } from "@/components/seat-card";
import HomeMonitorRow from "@/components/home-monitor-row";
import GuidePulseOverlay from "@/components/guide-pulse-overlay";
import { FontSize as fontsize, Spacing as spacing, type ThemePalette } from "@/constants/theme";
import { UAT_RESEARCHER_LONG_PRESS_MS } from "@/constants/uat";
import { getSeatDisplayState } from "@/utils/monitoring-presentation";
import { useTheme } from "@/hooks/use-theme";
import { useSafeSeatHub } from "@/hooks/safeseat-hub-context";
import { useDriverGuide } from "@/hooks/driver-guide-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Host, Icon } from "@expo/ui";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import checkXml from "@expo/material-symbols/check.xml";
import circleXml from "@expo/material-symbols/circle.xml";
import lockOpenXml from "@expo/material-symbols/lock_open.xml";
import sirenXml from "@expo/material-symbols/siren.xml";
import warningXml from "@expo/material-symbols/warning.xml";

export type SeatState =
  | "empty"
  | "assigned"
  | "safe"
  | "warning"
  | "emergency"
  | "unknown"
  | "consent"
  | "declined"
  | "offline"
  | "ready"
  | "monitoring";

type ConsentState = "confirmed" | "declined";

type Profile = {
  id: string;
  name: string;
  photoURL?: string;
  icon?: string;
  isAccountOwner?: boolean;
  isGuest?: boolean;
  sessionOnly?: boolean;
};

const SEAT_ASSIGNMENTS_KEY = "seatAssignments";
const IS_LOCKED_IN_KEY = "isLockedIn";
const SEAT_STATUSES_KEY = "seatStatuses";
const HARDWARE_SEAT_KEY = "safeSeatHardwareSeatNo";
const SEAT_CONSENTS_KEY = "seatSessionConsents";

const SEAT_ROLES: Record<number, string> = {
  1: "Driver",
  2: "Front Passenger",
  3: "Rear Left",
  4: "Rear Center",
  5: "Rear Right",
};

const SEAT_NUMBERS = [1, 2, 3, 4, 5];

const buildStatusCopy = (themes: ThemePalette) => ({
  safe: {
    label: "SAFE",
    headline: "No unusual signs detected",
    detail: "Monitoring continues automatically.",
    color: themes.green,
  },
  warning: {
    label: "WARNING",
    headline: "SafeSeat detected something unusual",
    detail: "Check on the person in this seat.",
    color: themes.lightOrange,
  },
  emergency: {
    label: "EMERGENCY",
    headline: "This person may need immediate help",
    detail: "Check this person and follow emergency guidance.",
    color: themes.warnBttn,
  },
  unknown: {
    label: "ANALYZING",
    headline: "SafeSeat is still checking",
    detail: "",
    color: themes.info,
  },
} as const);

type OverallState = "safe" | "warning" | "emergency" | "unknown";

const getHeroColors = (themes: ThemePalette, state: OverallState): [string, string, string] => {
  if (themes.mode === "light") {
    if (state === "safe") return ["#E4F7EC", "#EFF9F3", "#FFFFFF"];
    if (state === "warning") return ["#FFF2D7", "#FFF8EA", "#FFFFFF"];
    if (state === "emergency") return ["#FDE7E9", "#FFF3F4", "#FFFFFF"];
    return ["#E6F1FB", "#F2F7FC", "#FFFFFF"];
  }
  if (state === "safe") return ["#123429", "#102A27", "#0E1D29"];
  if (state === "warning") return ["#352F1F", "#1F2A2C", "#0E1D29"];
  if (state === "emergency") return ["#382329", "#23232D", "#0E1D29"];
  return ["#182D43", "#12263A", "#0E1D29"];
};

export default function Home() {
  const themes = useTheme();
  const styles = createStyles(themes);
  const STATUS_COPY = useMemo(() => buildStatusCopy(themes), [themes]);
  const router = useRouter();
  const { isStep, recordLiveSeatOpened } = useDriverGuide();
  const insets = useSafeAreaInsets();
  const bottomPad = 88 + insets.bottom;
  const {
    connected: hubConnected,
    telemetryReady,
    status: hubStatus,
    seatState: hubSeatState,
    rawSeatState,
    simulationActive,
    resetDecisionLatch,
    setSimulationState,
    armUatWarning,
    cancelUatWarning,
    emergencyAlertAcknowledged,
    acknowledgeEmergencyAlert,
    silenceAlertFeedback,
  } = useSafeSeatHub();

  const [isLockedIn, setIsLockedIn] = useState(false);
  const [assignments, setAssignments] = useState<Record<number, Profile>>({});
  const [hardwareSeatNo, setHardwareSeatNo] = useState<number | null>(null);
  const [consents, setConsents] = useState<Record<number, ConsentState>>({});
  const [dismissedSeats, setDismissedSeats] = useState<Set<number>>(new Set());
  const [endSessionVisible, setEndSessionVisible] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [screenFocused, setScreenFocused] = useState(true);
  const [animationCycle, setAnimationCycle] = useState(0);
  const [uatControlVisible, setUatControlVisible] = useState(false);

  const heroEntrance = useRef(new Animated.Value(0)).current;
  const ambientPulse = useRef(new Animated.Value(0)).current;
  const livePulse = useRef(new Animated.Value(0)).current;
  const stateMotion = useRef(new Animated.Value(0)).current;
  const passengerEntrance = useRef(SEAT_NUMBERS.map(() => new Animated.Value(0))).current;

  const loadData = useCallback(async () => {
    try {
      const [rawLockedIn, rawAssignments, rawHardwareSeat, rawConsents] = await Promise.all([
        AsyncStorage.getItem(IS_LOCKED_IN_KEY),
        AsyncStorage.getItem(SEAT_ASSIGNMENTS_KEY),
        AsyncStorage.getItem(HARDWARE_SEAT_KEY),
        AsyncStorage.getItem(SEAT_CONSENTS_KEY),
      ]);

      const parsedAssignments: Record<number, Profile> = rawAssignments ? JSON.parse(rawAssignments) : {};
      const parsedHardwareSeat = rawHardwareSeat ? Number(JSON.parse(rawHardwareSeat)) : null;
      setIsLockedIn(rawLockedIn ? JSON.parse(rawLockedIn) : false);
      setAssignments(parsedAssignments);
      setConsents(rawConsents ? JSON.parse(rawConsents) : {});
      setHardwareSeatNo(
        parsedHardwareSeat && parsedAssignments[parsedHardwareSeat]
          ? parsedHardwareSeat
          : (Number(Object.keys(parsedAssignments)[0]) || null),
      );
    } catch (error) {
      console.error("Failed to load home state from device:", error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      setAnimationCycle((value) => value + 1);
      void loadData();

      return () => {
        setScreenFocused(false);
        heroEntrance.stopAnimation();
        ambientPulse.stopAnimation();
        livePulse.stopAnimation();
        stateMotion.stopAnimation();
        heroEntrance.setValue(1);
        ambientPulse.setValue(0);
        livePulse.setValue(0);
        stateMotion.setValue(0);
        passengerEntrance.forEach((value) => value.setValue(1));
      };
    }, [ambientPulse, heroEntrance, livePulse, loadData, passengerEntrance, stateMotion]),
  );

  useEffect(() => {
    if (!screenFocused) {
      ambientPulse.setValue(0);
      return;
    }
    const ambientLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(ambientPulse, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(ambientPulse, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    ambientLoop.start();
    return () => ambientLoop.stop();
  }, [ambientPulse, screenFocused]);

  useEffect(() => {
    if (!screenFocused) {
      livePulse.setValue(0);
      return;
    }
    const liveLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(livePulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    if (isLockedIn && hubConnected) liveLoop.start();
    return () => liveLoop.stop();
  }, [hubConnected, isLockedIn, livePulse, screenFocused]);

  const getSeatState = useCallback((seatNo: number): SeatState => {
    return getSeatDisplayState({
      assigned: Boolean(assignments[seatNo]),
      ownerDriver: seatNo === 1 && Boolean(assignments[seatNo]?.isAccountOwner),
      consent: consents[seatNo], linked: seatNo === hardwareSeatNo,
      connected: hubConnected, ready: telemetryReady, active: isLockedIn, liveState: hubSeatState,
    });
  }, [assignments, consents, hardwareSeatNo, hubConnected, hubSeatState, isLockedIn, simulationActive, telemetryReady]);

  const getDisplayName = (profile?: Profile): string | undefined => {
    if (!profile) return undefined;
    if (profile.isGuest || profile.sessionOnly) return "Guest";
    return profile.isAccountOwner ? "Me" : profile.name;
  };

  const assignedSeatCount = SEAT_NUMBERS.filter((seatNo) => Boolean(assignments[seatNo])).length;
  const guestSeatCount = SEAT_NUMBERS.filter((seatNo) => {
    const profile = assignments[seatNo];
    return Boolean(profile?.isGuest || profile?.sessionOnly);
  }).length;

  const vitalSigns = useMemo<SeatVitals>(() => {
    const c1001 = hubStatus?.sensors?.c1001;
    const qualityTrusted = Boolean(
      hubConnected &&
      telemetryReady &&
      c1001?.connected &&
      !c1001?.stale &&
      c1001?.trusted_vitals
    );

    const heartRateBpm = qualityTrusted && typeof c1001?.heart_rate_bpm === "number" && Number.isFinite(c1001.heart_rate_bpm)
      ? Math.round(c1001.heart_rate_bpm)
      : null;
    const respirationRateBpm = qualityTrusted && typeof c1001?.respiration_rate_bpm === "number" && Number.isFinite(c1001.respiration_rate_bpm)
      ? Math.round(c1001.respiration_rate_bpm * 10) / 10
      : null;

    return {
      trusted: qualityTrusted && heartRateBpm !== null && respirationRateBpm !== null,
      heartRateBpm,
      respirationRateBpm,
      statusLabel: !c1001?.connected
        ? "UNAVAILABLE"
        : qualityTrusted
          ? "LIVE"
          : "REACQUIRING",
    };
  }, [hubConnected, hubStatus?.sensors?.c1001, telemetryReady]);

  const overallState = useMemo<OverallState>(() => {
    if (!isLockedIn || assignedSeatCount === 0) return "unknown";
    const activeStates = SEAT_NUMBERS
      .filter((seatNo) => Boolean(assignments[seatNo]))
      .map((seatNo) => getSeatState(seatNo));

    if (activeStates.includes("emergency")) return "emergency";
    if (activeStates.includes("warning")) return "warning";
    if (activeStates.includes("safe")) return "safe";
    return "unknown";
  }, [assignedSeatCount, assignments, getSeatState, isLockedIn]);

  useEffect(() => {
    if (!screenFocused) {
      heroEntrance.setValue(1);
      return;
    }
    heroEntrance.setValue(0);
    Animated.spring(heroEntrance, {
      toValue: 1,
      damping: 17,
      stiffness: 145,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [heroEntrance, isLockedIn, overallState, screenFocused]);

  useEffect(() => {
    stateMotion.stopAnimation();
    stateMotion.setValue(0);

    if (!screenFocused || !isLockedIn) return;

    if (overallState === "unknown") return;

    const duration = overallState === "safe" ? 1500 : overallState === "warning" ? 700 : 520;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(stateMotion, {
          toValue: 1,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(stateMotion, {
          toValue: 0,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isLockedIn, overallState, screenFocused, stateMotion]);

  useEffect(() => {
    const assigned = SEAT_NUMBERS.filter((seatNo) => Boolean(assignments[seatNo]));
    passengerEntrance.forEach((value) => value.setValue(screenFocused ? 0 : 1));
    if (!screenFocused || !isLockedIn || assigned.length === 0) return;

    Animated.stagger(70, assigned.map((seatNo) =>
      Animated.spring(passengerEntrance[seatNo - 1], {
        toValue: 1,
        damping: 18,
        stiffness: 155,
        mass: 0.75,
        useNativeDriver: true,
      })
    )).start();
  }, [assignments, isLockedIn, passengerEntrance, screenFocused]);

  const overallSeatNo = useMemo(() => {
    if (overallState === "safe") return hardwareSeatNo ?? undefined;
    return SEAT_NUMBERS.find((seatNo) => Boolean(assignments[seatNo]) && getSeatState(seatNo) === overallState);
  }, [assignments, getSeatState, hardwareSeatNo, overallState]);

  const copy = STATUS_COPY[overallState];
  const heroColors = getHeroColors(themes, overallState);
  const overallIcon = overallState === "safe"
    ? Icon.select({ ios: "checkmark.circle.fill", android: checkXml })
    : overallState === "warning"
      ? Icon.select({ ios: "exclamationmark.triangle.fill", android: warningXml })
      : overallState === "emergency"
        ? Icon.select({ ios: "light.beacon.max.fill", android: sirenXml })
        : Icon.select({ ios: "circle.dotted", android: circleXml });

  const getProfilePhoto = (profile?: Profile): string | undefined =>
    profile?.icon || profile?.photoURL;

  const showSeatDetails = (seatNo: number) => {
    const profile = assignments[seatNo];
    if (!profile) return;

    const state = getSeatState(seatNo);
    const specialCopy: Partial<Record<SeatState, { label: string; headline: string; detail?: string }>> = {
      consent: { label: "CONSENT NEEDED", headline: "Monitoring consent has not been confirmed.", detail: "Open Seats to review consent." },
      declined: { label: "NOT MONITORED", headline: "Monitoring consent was declined." },
      offline: { label: "OFFLINE", headline: "SafeSeat is not receiving monitoring data for this seat." },
      ready: { label: "READY", headline: "This seat is ready to be monitored." },
      monitoring: { label: "MONITORING", headline: "Monitoring is active for this seat." },
      assigned: { label: "NOT MONITORED", headline: "A person is assigned here, but no sensor is linked to this seat." },
    };
    const stateCopy = state === "safe" || state === "warning" || state === "emergency" || state === "unknown"
      ? STATUS_COPY[state]
      : specialCopy[state] ?? { label: "STATUS", headline: "SafeSeat status is unavailable." };
    const person = getDisplayName(profile);
    const message = [person, stateCopy.headline, stateCopy.detail].filter(Boolean).join("\n\n");

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (seatNo === hardwareSeatNo) recordLiveSeatOpened(seatNo);
    Alert.alert(`${SEAT_ROLES[seatNo]} · ${stateCopy.label}`, message);
  };

  const openEndSession = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setEndSessionVisible(true);
  };

  const confirmEndSession = async () => {
    if (endingSession) return;
    setEndingSession(true);

    try {
      const persistentAssignments: Record<number, Profile> = {};
      Object.entries(assignments).forEach(([seatNo, profile]) => {
        if (!profile.sessionOnly && !profile.isGuest) {
          persistentAssignments[Number(seatNo)] = profile;
        }
      });

      let nextHardwareSeat = hardwareSeatNo;
      if (nextHardwareSeat && !persistentAssignments[nextHardwareSeat]) {
        nextHardwareSeat = Number(Object.keys(persistentAssignments)[0]) || null;
      }

      const writes: Promise<void>[] = [
        AsyncStorage.setItem(IS_LOCKED_IN_KEY, JSON.stringify(false)),
        AsyncStorage.setItem(SEAT_ASSIGNMENTS_KEY, JSON.stringify(persistentAssignments)),
        AsyncStorage.setItem(SEAT_STATUSES_KEY, JSON.stringify({})),
        AsyncStorage.removeItem(SEAT_CONSENTS_KEY),
      ];

      if (nextHardwareSeat) {
        writes.push(AsyncStorage.setItem(HARDWARE_SEAT_KEY, JSON.stringify(nextHardwareSeat)));
      } else {
        writes.push(AsyncStorage.removeItem(HARDWARE_SEAT_KEY));
      }

      await Promise.all(writes);

      setIsLockedIn(false);
      cancelUatWarning();
      silenceAlertFeedback();
      resetDecisionLatch();
      setSimulationState("off");
      setAssignments(persistentAssignments);
      setConsents({});
      setHardwareSeatNo(nextHardwareSeat);
      setEndSessionVisible(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/assign");
    } catch (error) {
      console.error("Failed to end session from Home:", error);
      Alert.alert("Could not end session", "SafeSeat could not end monitoring. Please try again.");
    } finally {
      setEndingSession(false);
    }
  };

  const openUatControl = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setUatControlVisible(true);
  };

  const armWarning = (delayMs: number) => {
    armUatWarning(delayMs);
    setUatControlVisible(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const emergencySeatNo = isLockedIn
    ? SEAT_NUMBERS.find(
        (seatNo) => getSeatState(seatNo) === "emergency" && assignments[seatNo] && !dismissedSeats.has(seatNo),
      )
    : undefined;
  const emergencyProfile = emergencySeatNo !== undefined ? assignments[emergencySeatNo] : undefined;

  const linkedDisplayState = hardwareSeatNo ? getSeatState(hardwareSeatNo) : null;

  useEffect(() => {
    if (!hardwareSeatNo || linkedDisplayState === "emergency") return;
    setDismissedSeats((previous) => {
      if (!previous.has(hardwareSeatNo)) return previous;
      const next = new Set(previous);
      next.delete(hardwareSeatNo);
      return next;
    });
  }, [hardwareSeatNo, linkedDisplayState]);

  const heroTranslateY = heroEntrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  const heroScale = heroEntrance.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] });
  const auraScale = ambientPulse.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.12] });
  const auraOpacity = ambientPulse.interpolate({ inputRange: [0, 1], outputRange: [0.045, 0.12] });
  const liveRingScale = livePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.3] });
  const liveRingOpacity = livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  const safeScale = stateMotion.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const attentionScale = stateMotion.interpolate({ inputRange: [0, 1], outputRange: [1, overallState === "emergency" ? 1.12 : 1.06] });
  const warningLift = stateMotion.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });
  const stateRingOpacity = stateMotion.interpolate({ inputRange: [0, 1], outputRange: [0.34, 0.06] });
  const stateRingScale = stateMotion.interpolate({ inputRange: [0, 1], outputRange: [0.92, overallState === "emergency" ? 1.35 : 1.22] });

  const renderStatusSymbol = () => {
    if (overallState === "unknown") {
      return (
        <View style={styles.symbolStage}>
          <View style={[styles.symbolCore, styles.symbolCoreRaised, { borderColor: `${copy.color}55`, backgroundColor: `${copy.color}10` }]}>
            <ActivityIndicator size="large" color={copy.color} />
          </View>
        </View>
      );
    }

    const animatedTransform = overallState === "safe"
      ? [{ scale: safeScale }]
      : overallState === "warning"
        ? [{ translateY: warningLift }, { scale: attentionScale }]
        : [{ scale: attentionScale }];

    return (
      <View style={styles.symbolStage}>
        <Animated.View
          style={[
            styles.statePulseRing,
            {
              borderColor: copy.color,
              opacity: stateRingOpacity,
              transform: [{ scale: stateRingScale }],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.symbolCore,
            styles.symbolCoreRaised,
            {
              borderColor: `${copy.color}77`,
              backgroundColor: `${copy.color}12`,
              transform: animatedTransform,
            },
          ]}
        >
          <ThemedHost matchContents>
            <Icon name={overallIcon} color={copy.color} size={52} />
          </ThemedHost>
        </Animated.View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.backgroundArt}>
        <Animated.View style={[styles.backgroundGlowTop, { opacity: auraOpacity, transform: [{ scale: auraScale }] }]} />
        <View style={styles.backgroundGlowBottom} />
      </View>

      <SafeAreaView style={styles.safeArea} edges={["left", "right", "bottom"]}>
        {isLockedIn ? (
          <View style={styles.activeContainer}>
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.eyebrow}>SAFESEAT ACTIVE</Text>
                <Text style={styles.pageHeader}>Cabin Monitor</Text>
              </View>

              <View style={[styles.liveBadge, !hubConnected && styles.liveBadgeOffline]}>
                <View style={styles.liveDotWrap}>
                  {hubConnected ? (
                    <Animated.View style={[styles.livePulseRing, { opacity: liveRingOpacity, transform: [{ scale: liveRingScale }] }]} />
                  ) : null}
                  <View style={[styles.liveDot, !hubConnected && styles.liveDotOffline]} />
                </View>
                <Text style={[styles.liveText, !hubConnected && styles.liveTextOffline]}>
                  {simulationActive ? "DEMO" : hubConnected ? (telemetryReady ? "LIVE" : "CONNECTING") : "OFFLINE"}
                </Text>
              </View>
            </View>

            <View style={styles.activeSeatList}>
              {SEAT_NUMBERS.map((seatNo) => (
                <View key={seatNo} style={styles.homeSeatRowActive}>
                  <HomeMonitorRow
                    seatNo={seatNo}
                    role={SEAT_ROLES[seatNo]}
                    name={getDisplayName(assignments[seatNo])}
                    photo={getProfilePhoto(assignments[seatNo])}
                    state={assignments[seatNo] ? getSeatState(seatNo) : "empty"}
                    isHardwareSeat={seatNo === hardwareSeatNo}
                    vitals={seatNo === hardwareSeatNo ? vitalSigns : undefined}
                    onPress={() => assignments[seatNo] ? showSeatDetails(seatNo) : router.push("/assign")}
                    onLongPress={seatNo === hardwareSeatNo && assignments[seatNo] ? openUatControl : undefined}
                    delayLongPress={seatNo === hardwareSeatNo ? UAT_RESEARCHER_LONG_PRESS_MS : undefined}
                  />
                  <GuidePulseOverlay
                    active={isStep("alerts") && seatNo === (hardwareSeatNo ?? SEAT_NUMBERS.find((n) => Boolean(assignments[n])) ?? 1)}
                    label="TAP STATUS"
                    borderRadius={18}
                    inset={-3}
                    beaconPosition="top"
                  />
                </View>
              ))}
            </View>

            <View style={styles.sessionControls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View and change seat assignments"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push("/assign");
                }}
                style={({ pressed }) => [styles.sessionControl, styles.seatsControl, pressed && styles.controlPressed]}
              >
                <View style={styles.sessionControlIcon}>
                  <ThemedHost matchContents>
                    <Icon name={Icon.select({ ios: "carseat.right.fill", android: lockOpenXml })} size={23} color={themes.primaryBttn} />
                  </ThemedHost>
                </View>
                <View style={styles.sessionControlCopy}>
                  <Text style={styles.sessionControlTitle}>Seats</Text>
                </View>
                <Text style={styles.sessionControlChevron}>›</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="End monitoring session"
                onPress={openEndSession}
                style={({ pressed }) => [styles.sessionControl, styles.endControl, pressed && styles.controlPressed]}
              >
                <View style={styles.endIconWrap}>
                  <View style={styles.endIconSquare} />
                </View>
                <View style={styles.sessionControlCopy}>
                  <Text style={styles.endControlTitle}>End Session</Text>
                </View>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.activeContainer}>
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.eyebrow}>SAFESEAT</Text>
                <Text style={styles.pageHeader}>Cabin Monitor</Text>
              </View>

              <View style={styles.setupBadge}>
                <View style={styles.setupBadgeDot} />
                <Text style={styles.setupBadgeText}>SETUP</Text>
              </View>
            </View>

            <View style={styles.activeSeatList}>
              {SEAT_NUMBERS.map((seatNo) => {
                const profile = assignments[seatNo];
                let setupState: SeatState = "empty";

                if (profile) {
                  const accountOwnerDriver = seatNo === 1 && Boolean(profile.isAccountOwner);
                  const consent = consents[seatNo];
                  if (!accountOwnerDriver && consent === "declined") setupState = "declined";
                  else if (!accountOwnerDriver && consent !== "confirmed") setupState = "consent";
                  else if (seatNo === hardwareSeatNo) setupState = hubConnected && telemetryReady ? "ready" : "offline";
                  else setupState = "assigned";
                }

                return (
                  <View key={seatNo} style={styles.homeSeatRowActive}>
                    <HomeMonitorRow
                      seatNo={seatNo}
                      role={SEAT_ROLES[seatNo]}
                      name={getDisplayName(profile)}
                      photo={getProfilePhoto(profile)}
                      state={setupState}
                    isHardwareSeat={seatNo === hardwareSeatNo}
                      onPress={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push("/assign");
                      }}
                    />
                  </View>
                );
              })}
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Configure seats"
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push("/assign");
              }}
              style={({ pressed }) => [styles.setupAction, pressed && styles.controlPressed]}
            >
              <View style={styles.setupActionCopy}>
                <Text style={styles.setupActionTitle}>Set Up Seats</Text>
              </View>
              <Text style={styles.setupActionChevron}>›</Text>
            </Pressable>
          </View>
        )}

        <Modal
          visible={uatControlVisible}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setUatControlVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setUatControlVisible(false)}
              accessibilityLabel="Close UAT control"
            />
            <View style={styles.uatModalCard}>
              <View style={styles.endModalHandle} />
              <Text style={styles.uatModalEyebrow}>RESEARCHER CONTROL</Text>
              <Text style={styles.uatModalTitle}>{simulationActive ? "Simulated Warning Active" : "Schedule Warning"}</Text>
              <Text style={styles.uatModalText}>
                {simulationActive
                  ? "Warning will stay active until you stop it. Real Main Hub Emergency still takes priority."
                  : "The linked monitored seat will enter Warning after the selected delay and stay there until you stop it."}
              </Text>

              {simulationActive ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Stop simulated warning"
                  onPress={() => { cancelUatWarning(); setUatControlVisible(false); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }}
                  style={({ pressed }) => [styles.uatCancelButton, pressed && styles.modalButtonPressed]}
                >
                  <Text style={styles.uatCancelText}>Stop Warning</Text>
                </Pressable>
              ) : (
                <>
                  <View style={styles.uatDelayRow}>
                    <Pressable onPress={() => armWarning(10_000)} style={({ pressed }) => [styles.uatDelayButton, pressed && styles.modalButtonPressed]}>
                      <Text style={styles.uatDelayTime}>10s</Text>
                      <Text style={styles.uatDelayLabel}>Warning</Text>
                    </Pressable>
                    <Pressable onPress={() => armWarning(30_000)} style={({ pressed }) => [styles.uatDelayButton, pressed && styles.modalButtonPressed]}>
                      <Text style={styles.uatDelayTime}>30s</Text>
                      <Text style={styles.uatDelayLabel}>Warning</Text>
                    </Pressable>
                    <Pressable onPress={() => armWarning(60_000)} style={({ pressed }) => [styles.uatDelayButton, pressed && styles.modalButtonPressed]}>
                      <Text style={styles.uatDelayTime}>60s</Text>
                      <Text style={styles.uatDelayLabel}>Warning</Text>
                    </Pressable>
                  </View>

                  <Pressable
                    onPress={() => { cancelUatWarning(); setUatControlVisible(false); void Haptics.selectionAsync(); }}
                    style={({ pressed }) => [styles.uatCancelButton, pressed && styles.modalButtonPressed]}
                  >
                    <Text style={styles.uatCancelText}>Cancel Armed Warning</Text>
                  </Pressable>
                </>
              )}
              <Pressable onPress={() => setUatControlVisible(false)} style={({ pressed }) => [styles.uatCloseButton, pressed && styles.modalButtonPressed]}>
                <Text style={styles.uatCloseText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal
          visible={endSessionVisible}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => !endingSession && setEndSessionVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => !endingSession && setEndSessionVisible(false)}
              accessibilityLabel="Close end session dialog"
            />
            <View style={styles.endModalCard}>
              <View style={styles.endModalHandle} />
              <View style={styles.endModalIcon}>
                <View style={styles.endModalStopSquare} />
              </View>
              <Text style={styles.endModalEyebrow}>MONITORING SESSION</Text>
              <Text style={styles.endModalTitle}>End this session?</Text>
              <Text style={styles.endModalText}>
                {guestSeatCount > 0
                  ? `Monitoring will stop. ${guestSeatCount} guest assignment${guestSeatCount === 1 ? "" : "s"} will also be removed.`
                  : "Monitoring will stop and SafeSeat will return to the Seats screen. Your saved seat assignments will stay available."}
              </Text>

              <View style={styles.endModalActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={endingSession}
                  onPress={() => setEndSessionVisible(false)}
                  style={({ pressed }) => [styles.keepMonitoringButton, pressed && styles.modalButtonPressed]}
                >
                  <Text style={styles.keepMonitoringText}>Keep Monitoring</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  disabled={endingSession}
                  onPress={() => void confirmEndSession()}
                  style={({ pressed }) => [styles.confirmEndButton, pressed && styles.modalButtonPressed, endingSession && styles.disabledButton]}
                >
                  {endingSession ? (
                    <ActivityIndicator size="small" color={themes.warnBttn} />
                  ) : (
                    <View style={styles.confirmEndDot} />
                  )}
                  <Text style={styles.confirmEndText}>{endingSession ? "Ending..." : "End Session"}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {emergencySeatNo !== undefined && emergencyProfile ? (
          <EmergencyModal
            seat={emergencySeatNo}
            visible
            onClose={() => setDismissedSeats((prev) => new Set(prev).add(emergencySeatNo))}
            id={emergencyProfile.id}
            name={emergencyProfile.isAccountOwner ? "You" : emergencyProfile.name}
            icon={emergencyProfile.photoURL ?? emergencyProfile.icon}
            isAccountOwner={emergencyProfile.isAccountOwner}
            vitals={vitalSigns}
            alertAcknowledged={emergencyAlertAcknowledged}
            onAcknowledgeAlert={acknowledgeEmergencyAlert}
            isRealEmergency={rawSeatState === "emergency" && !simulationActive}
          />
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const createStyles = (themes: ThemePalette) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: themes.background,
    position: "relative",
    overflow: "hidden",
  },
  backgroundArt: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  backgroundGlowTop: {
    position: "absolute",
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: themes.primaryBttn,
    top: -220,
    right: -160,
  },
  backgroundGlowBottom: {
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: themes.info,
    opacity: 0.13,
    bottom: 30,
    left: -185,
  },
  safeArea: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, paddingTop: spacing.half },
  container: { flex: 1, width: "100%", paddingHorizontal: spacing.two, gap: spacing.one },
  activeContainer: {
    flex: 1,
    width: "100%",
    paddingHorizontal: spacing.two,
    paddingTop: spacing.half,
    paddingBottom: spacing.one,
    gap: 7,
    minHeight: 0,
  },
  activeSeatList: { flex: 1, minHeight: 0, gap: 7 },
  homeSeatRowActive: { flex: 1, minHeight: 0, width: "100%", position: "relative", overflow: "visible" },
  monitorBoardHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: 2, marginTop: -2 },
  monitorBoardEyebrow: { color: themes.primaryBttn, fontSize: 9, letterSpacing: 1.05, fontFamily: "Body-Bold" },
  monitorBoardTitle: { color: themes.text, fontSize: 14.5, lineHeight: 17, fontFamily: "Body-Bold", marginTop: 1 },
  monitorBoardHint: { color: themes.textMuted, fontSize: 8.5, lineHeight: 11, fontFamily: "Body-Regular", textAlign: "right" },
  setupBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  setupBadgeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: themes.lightOrange },
  setupBadgeText: { color: themes.textSecondary, fontSize: 10, letterSpacing: 0.7, fontFamily: "Body-Bold" },
  setupAction: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
    backgroundColor: themes.primarySoft,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  setupActionCopy: { flex: 1, minWidth: 0 },
  setupActionTitle: { color: themes.primaryBttn, fontSize: 15, lineHeight: 18, fontFamily: "Body-Bold" },
  setupActionText: { color: themes.textSecondary, fontSize: 10.5, lineHeight: 13, fontFamily: "Body-Regular", marginTop: 2 },
  setupActionChevron: { color: themes.primaryBttn, fontSize: 26, lineHeight: 28, fontFamily: "Body-Regular" },

  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { color: themes.primaryBttn, fontSize: 11.5, letterSpacing: 1.25, fontFamily: "Body-Bold" },
  pageHeader: { fontSize: 28, fontFamily: "Logo-Font", color: themes.text, marginTop: 1 },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.half,
    paddingHorizontal: spacing.one + 3,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
    shadowColor: themes.primaryBttn,
    shadowOpacity: 0.13,
    shadowRadius: 8,
  },
  liveBadgeOffline: { backgroundColor: themes.surfaceSoft, borderColor: themes.divider, shadowOpacity: 0 },
  liveDotWrap: { width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  livePulseRing: { position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: themes.primaryBttn },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: themes.primaryBttn },
  liveDotOffline: { backgroundColor: themes.textMuted },
  liveText: { color: themes.primaryBttn, fontSize: 10.5, letterSpacing: 0.7, fontFamily: "Body-Bold" },
  liveTextOffline: { color: themes.textMuted },

  statusConsole: {
    position: "relative",
    overflow: "hidden",
    paddingHorizontal: spacing.two,
    paddingTop: spacing.two,
    paddingBottom: spacing.two,
    borderRadius: 28,
    borderWidth: 1.1,
    shadowColor: themes.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 12 },
    elevation: 7,
  },
  stateAccentLine: {
    position: "absolute",
    top: 0,
    left: 26,
    right: 26,
    height: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    opacity: 0.92,
  },
  statusGlow: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 150,
    top: -210,
    left: "50%",
    marginLeft: -150,
  },
  consoleBrandGlow: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: themes.primaryBttn,
    opacity: 0.03,
    bottom: -165,
    right: -80,
  },
  consoleTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.one,
  },
  consoleTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  consoleIndicator: { width: 7, height: 7, borderRadius: 4 },
  consoleEyebrow: { color: themes.textSecondary, fontSize: 8.5, letterSpacing: 1.05, fontFamily: "Body-Bold" },
  occupantPill: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  occupantPillNumber: { color: themes.text, fontSize: 11, fontFamily: "Body-Bold" },
  occupantPillLabel: { color: themes.textMuted, fontSize: 7.5, letterSpacing: 0.45, fontFamily: "Body-Bold" },

  consoleMain: {
    minHeight: 228,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.one,
    paddingTop: spacing.one,
    paddingBottom: spacing.two,
  },
  symbolStage: {
    width: 100,
    height: 100,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginBottom: spacing.one,
  },
  symbolCore: {
    width: 82,
    height: 82,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.2,
    zIndex: 3,
  },
  symbolCoreRaised: {
    shadowColor: themes.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 4,
  },
  statePulseRing: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 27,
    borderWidth: 1.3,
  },
  statusLabel: {
    fontSize: 31,
    lineHeight: 35,
    letterSpacing: 1.5,
    fontFamily: "Body-Bold",
    textAlign: "center",
  },
  statusHeadline: {
    color: themes.text,
    fontSize: 17,
    lineHeight: 22,
    fontFamily: "Body-Bold",
    textAlign: "center",
    marginTop: 6,
    maxWidth: 310,
  },
  statusDetail: {
    color: themes.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: "Body-Regular",
    textAlign: "center",
    marginTop: 6,
    maxWidth: 300,
  },
  focusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: spacing.two,
  },
  focusChipCaption: { color: themes.textMuted, fontSize: 7.5, letterSpacing: 0.8, fontFamily: "Body-Bold" },
  focusChipText: { fontSize: 10.5, letterSpacing: 0.25, fontFamily: "Body-Bold" },

  consoleBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.one,
    paddingTop: spacing.one + 2,
    borderTopWidth: 1,
    borderTopColor: themes.divider,
  },
  monitoringChip: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1 },
  monitoringChipDot: { width: 7, height: 7, borderRadius: 4 },
  monitoringChipText: { color: themes.textSecondary, fontSize: 9.5, fontFamily: "Body-Bold" },
  consoleBottomHint: { color: themes.textMuted, fontSize: 8.5, fontFamily: "Body-Regular", textAlign: "right", flexShrink: 1 },

  preSessionTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.one,
  },
  preSessionLabel: { color: themes.textMuted, fontSize: 8.5, letterSpacing: 1.05, fontFamily: "Body-Bold" },
  preSessionTitle: { color: themes.text, fontSize: 19, fontFamily: "Body-Bold", marginTop: 2 },
  chooseSeatsButton: {
    minHeight: 40,
    paddingHorizontal: spacing.two,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.primaryBttn,
    shadowColor: themes.primaryBttn,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  chooseSeatsButtonText: { color: themes.primaryBttnText, fontSize: 13, fontFamily: "Body-Bold" },

  sessionControls: { flexDirection: "row", gap: spacing.one },
  sessionControl: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.one + 3,
    gap: spacing.one,
  },
  seatsControl: {
    backgroundColor: themes.primarySoft,
    borderColor: themes.primaryBorder,
  },
  endControl: {
    backgroundColor: `${themes.warnBttn}0D`,
    borderColor: `${themes.warnBttn}38`,
  },
  controlPressed: { opacity: 0.77, transform: [{ scale: 0.985 }] },
  sessionControlIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  sessionControlCopy: { flex: 1, minWidth: 0 },
  sessionControlTitle: { color: themes.text, fontSize: 16, fontFamily: "Body-Bold" },
  sessionControlText: { color: themes.textMuted, fontSize: 10.5, marginTop: 2, fontFamily: "Body-Regular" },
  sessionControlChevron: { color: themes.primaryBttn, fontSize: 27, lineHeight: 27, fontFamily: "Body-Regular" },
  endIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${themes.warnBttn}14`,
    borderWidth: 1,
    borderColor: `${themes.warnBttn}3D`,
  },
  endIconSquare: { width: 13, height: 13, borderRadius: 3, backgroundColor: themes.warnBttn },
  endControlTitle: { color: themes.warnBttn, fontSize: 14.5, fontFamily: "Body-Bold" },
  endControlText: { color: themes.textMuted, fontSize: 10.5, marginTop: 2, fontFamily: "Body-Regular" },

  section: { gap: spacing.one },
  sectionHeadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  sectionHeader: { fontSize: 20, fontFamily: "Heading-Font", color: themes.text },
  sectionSubhead: { color: themes.textMuted, fontSize: 9.5, marginTop: 2, fontFamily: "Body-Regular" },
  sectionCountPill: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  sectionCountText: { color: themes.textSecondary, fontSize: 11, fontFamily: "Body-Bold" },
  peopleGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.one },
  personTileWrap: { width: "48.5%" },

  setupHero: {
    position: "relative",
    overflow: "hidden",
    marginTop: spacing.one,
    paddingHorizontal: spacing.two,
    paddingTop: spacing.two,
    paddingBottom: spacing.two,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
    minHeight: 410,
    shadowColor: themes.shadow,
    shadowOpacity: 0.24,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 11 },
    elevation: 6,
  },
  setupGlow: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: themes.primaryBttn,
    top: -205,
    right: -115,
  },
  setupTopRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.one },
  setupReadyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  setupReadyDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: themes.primaryBttn },
  setupReadyText: { color: themes.primaryBttn, fontSize: 8, letterSpacing: 0.7, fontFamily: "Body-Bold" },
  setupEyebrow: { color: themes.primaryBttn, fontSize: 8.5, letterSpacing: 1.1, fontFamily: "Body-Bold" },
  setupTitle: { color: themes.text, fontSize: 27, lineHeight: 32, fontFamily: "Body-Bold", marginTop: 4 },
  setupSubtitle: { color: themes.textSecondary, fontSize: 12.5, lineHeight: 18, fontFamily: "Body-Regular", marginTop: spacing.one, maxWidth: 330 },

  cabinPreview: {
    marginTop: spacing.two,
    padding: spacing.one + 4,
    borderRadius: 22,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
    gap: spacing.one,
  },
  cabinPreviewHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  cabinPreviewLabel: { color: themes.textSecondary, fontSize: 8, letterSpacing: 1, fontFamily: "Body-Bold" },
  cabinPreviewHint: { color: themes.textMuted, fontSize: 8.5, fontFamily: "Body-Regular" },
  cabinFrontRow: { flexDirection: "row", gap: spacing.one, paddingHorizontal: spacing.two },
  cabinRearRow: { flexDirection: "row", gap: spacing.one },
  cabinSeat: {
    flex: 1,
    minHeight: 66,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.backgroundElement,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  cabinSeatPrimary: { backgroundColor: themes.primarySoft, borderColor: themes.primaryBorder },
  cabinSeatSmall: {
    flex: 1,
    minHeight: 58,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.backgroundElement,
    borderWidth: 1,
    borderColor: themes.divider,
  },
  cabinSeatShort: { color: themes.primaryBttn, fontSize: 16, fontFamily: "Body-Bold" },
  cabinSeatShortSmall: { color: themes.textSecondary, fontSize: 13, fontFamily: "Body-Bold" },
  cabinSeatLabel: { color: themes.textSecondary, fontSize: 8.5, marginTop: 3, fontFamily: "Body-Bold" },
  cabinSeatLabelSmall: { color: themes.textMuted, fontSize: 7.5, marginTop: 2, fontFamily: "Body-Bold" },

  setupSummaryPanel: {
    marginTop: spacing.two,
    borderRadius: 20,
    padding: spacing.one + 4,
    backgroundColor: themes.surfaceSoft,
    borderWidth: 1,
    borderColor: themes.divider,
    gap: spacing.one,
  },
  setupSummaryTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.one },
  setupSummaryEyebrow: { color: themes.textMuted, fontSize: 8, letterSpacing: 0.9, fontFamily: "Body-Bold" },
  setupSummaryCount: { color: themes.text, fontSize: 14, marginTop: 3, fontFamily: "Body-Bold" },
  setupSummaryStatus: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: themes.surfaceSoft, borderWidth: 1, borderColor: themes.divider },
  setupSummaryStatusReady: { backgroundColor: themes.primarySoft, borderColor: themes.primaryBorder },
  setupSummaryDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: themes.textMuted },
  setupSummaryDotReady: { backgroundColor: themes.primaryBttn },
  setupSummaryStatusText: { color: themes.textMuted, fontSize: 7.5, letterSpacing: 0.55, fontFamily: "Body-Bold" },
  setupSummaryStatusTextReady: { color: themes.primaryBttn },
  setupPeoplePreview: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  setupPersonChip: { width: "48.5%", minHeight: 46, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 14, backgroundColor: themes.backgroundElement, borderWidth: 1, borderColor: themes.divider },
  setupPersonAvatar: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: themes.primarySoft, borderWidth: 1, borderColor: themes.primaryBorder },
  setupPersonInitial: { color: themes.primaryBttn, fontSize: 11, fontFamily: "Body-Bold" },
  setupPersonName: { color: themes.text, fontSize: 10.5, fontFamily: "Body-Bold" },
  setupPersonSeat: { color: themes.textMuted, fontSize: 7.5, marginTop: 1, fontFamily: "Body-Regular" },
  setupEmptySummary: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: spacing.one },
  setupEmptyIcon: { width: 36, height: 36, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: themes.primarySoft, borderWidth: 1, borderColor: themes.primaryBorder },
  setupEmptyIconText: { color: themes.primaryBttn, fontSize: 22, lineHeight: 23, fontFamily: "Body-Regular" },
  setupEmptyTitle: { color: themes.text, fontSize: 12.5, fontFamily: "Body-Bold" },
  setupEmptyText: { color: themes.textMuted, fontSize: 9, marginTop: 2, fontFamily: "Body-Regular" },

  setupPrimaryAction: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.one,
    paddingHorizontal: spacing.one + 3,
    marginTop: spacing.two,
    borderRadius: 20,
    backgroundColor: themes.primaryBttn,
    shadowColor: themes.primaryBttn,
    shadowOpacity: 0.2,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 4,
  },
  setupPrimaryActionPressed: { opacity: 0.86, transform: [{ scale: 0.988 }] },
  setupPrimaryIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.mode === "dark" ? "rgba(5,22,14,0.12)" : "rgba(255,255,255,0.18)",
  },
  setupPrimaryIconText: { color: themes.primaryBttnText, fontSize: 25, lineHeight: 27, fontFamily: "Body-Regular" },
  setupPrimaryCopy: { flex: 1 },
  setupPrimaryTitle: { color: themes.primaryBttnText, fontSize: 14, fontFamily: "Body-Bold" },
  setupPrimaryText: { color: themes.mode === "dark" ? "rgba(5,22,14,0.72)" : "rgba(255,255,255,0.84)", fontSize: 9, marginTop: 2, fontFamily: "Body-Bold" },
  setupPrimaryChevron: { color: themes.primaryBttnText, fontSize: 28, lineHeight: 28, fontFamily: "Body-Regular" },

  uatModalCard: {
    width: "88%",
    maxWidth: 430,
    alignSelf: "center",
    borderRadius: 24,
    padding: spacing.two,
    backgroundColor: themes.backgroundElement,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
    gap: spacing.one,
  },
  uatModalEyebrow: { color: themes.primaryBttn, fontSize: 9, letterSpacing: 1.2, fontFamily: "Body-Bold", marginTop: 4 },
  uatModalTitle: { color: themes.text, fontSize: 23, fontFamily: "Body-Bold" },
  uatModalText: { color: themes.textMuted, fontSize: 12.5, lineHeight: 18, fontFamily: "Body-Regular" },
  uatDelayRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  uatDelayButton: {
    flex: 1,
    minHeight: 74,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  uatDelayTime: { color: themes.text, fontSize: 20, fontFamily: "Body-Bold" },
  uatDelayLabel: { color: themes.primaryBttn, fontSize: 10, marginTop: 3, fontFamily: "Body-Bold", letterSpacing: 0.5 },
  uatCancelButton: {
    minHeight: 46,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: themes.divider,
    backgroundColor: themes.surfaceSoft,
    marginTop: 4,
  },
  uatCancelText: { color: themes.lightOrange, fontSize: 12, fontFamily: "Body-Bold" },
  uatCloseButton: { minHeight: 42, alignItems: "center", justifyContent: "center" },
  uatCloseText: { color: themes.textMuted, fontSize: 12, fontFamily: "Body-Bold" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: themes.overlay,
    justifyContent: "flex-end",
    paddingHorizontal: spacing.two,
    paddingBottom: spacing.two,
  },
  endModalCard: {
    borderRadius: 30,
    backgroundColor: themes.backgroundElevated,
    borderWidth: 1,
    borderColor: themes.divider,
    paddingHorizontal: spacing.three,
    paddingTop: spacing.one,
    paddingBottom: spacing.three,
    alignItems: "center",
    shadowColor: themes.shadow,
    shadowOpacity: 0.45,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: -10 },
    elevation: 14,
  },
  endModalHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: themes.divider, marginBottom: spacing.three },
  endModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,103,111,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,103,111,0.30)",
    marginBottom: spacing.two,
  },
  endModalStopSquare: { width: 22, height: 22, borderRadius: 5, backgroundColor: themes.warnBttn },
  endModalEyebrow: { color: themes.warnBttn, fontSize: 8.5, letterSpacing: 1.15, fontFamily: "Body-Bold" },
  endModalTitle: { color: themes.text, fontSize: 25, lineHeight: 30, fontFamily: "Body-Bold", marginTop: 5, textAlign: "center" },
  endModalText: { color: themes.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: "Body-Regular", textAlign: "center", marginTop: spacing.one, maxWidth: 315 },
  endModalActions: { width: "100%", gap: spacing.one, marginTop: spacing.three },
  keepMonitoringButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: themes.primarySoft,
    borderWidth: 1,
    borderColor: themes.primaryBorder,
  },
  keepMonitoringText: { color: themes.primaryBttn, fontSize: 15, fontFamily: "Body-Bold" },
  confirmEndButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.one,
    borderRadius: 17,
    backgroundColor: "rgba(255,103,111,0.075)",
    borderWidth: 1,
    borderColor: "rgba(255,103,111,0.28)",
  },
  confirmEndDot: { width: 11, height: 11, borderRadius: 3, backgroundColor: themes.warnBttn },
  confirmEndText: { color: themes.warnBttn, fontSize: 15, fontFamily: "Body-Bold" },
  modalButtonPressed: { opacity: 0.76, transform: [{ scale: 0.99 }] },
  disabledButton: { opacity: 0.55 },
  guideTarget: {
    borderWidth: 2,
    borderColor: themes.primaryBttn,
    borderRadius: 20,
    padding: 4,
    shadowColor: themes.primaryBttn,
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
});
