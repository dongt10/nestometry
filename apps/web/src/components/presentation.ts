export function lowerText(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

export function humanizePlannerMessage(value: string): string {
  return lowerText(value.replaceAll('_', ' '));
}

export function roomChoiceName(displayName: string, hall: string): string {
  return lowerText(
    displayName
      .replace(`${hall} `, '')
      .replace(/\s+—\s+Representative$/i, '')
  );
}

export function formatRoomCount(count: number): string {
  return `${count} room ${count === 1 ? 'example' : 'examples'}`;
}
