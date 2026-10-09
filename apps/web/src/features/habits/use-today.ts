"use client";

import { useQuery } from "@tanstack/react-query";

import { todayInTimezone } from "@/lib/habits/date";
import { PROFILE_QUERY_KEY, fetchProfile } from "@/lib/profile/profile-api";

/** プロフィールの timezone における今日の日付。取得できるまで `undefined`(日付を推測しない)。 */
export function useToday(): { today: string | undefined; isError: boolean; refetch: () => void } {
  const query = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: ({ signal }) => fetchProfile(signal),
  });
  return {
    today: query.data === undefined ? undefined : todayInTimezone(new Date(), query.data.timezone),
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
