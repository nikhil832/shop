import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useFetch } from '../useFetch.js';

// The store's announcement (stage 71, Admin → Announcements) across the top of every shop page. Asked for once per
// page load (Layout stays mounted while moving between pages). A visitor who closes it doesn't see that one again in
// this browser; a new announcement shows.
const CLOSED = 'bazaar.closedAnnouncement';
// Not in the admin panel, nor on invoices and credit notes (printed).
const HIDDEN_ON = /^\/admin(\/|$)|^\/orders\/[^/]+\/(invoice|credit-notes)/;

function closedId() {
  try {
    return localStorage.getItem(CLOSED);
  } catch {
    return null;
  }
}

export default function AnnouncementBar() {
  const { pathname } = useLocation();
  const { data } = useFetch('/announcement');
  const [closed, setClosed] = useState(closedId);
  const announcement = data?.announcement;
  if (!announcement || announcement.id === closed || HIDDEN_ON.test(pathname)) return null;

  function close() {
    try {
      localStorage.setItem(CLOSED, announcement.id);
    } catch {
      // Storage blocked: closed for this page load only.
    }
    setClosed(announcement.id);
  }

  return (
    <aside className="announcement no-print" aria-label="Announcement">
      <p>
        {announcement.text}
        {announcement.link && (
          <>
            {' '}
            <Link to={announcement.link}>Find out more</Link>
          </>
        )}
      </p>
      <button type="button" className="announcement-close" aria-label="Close announcement" onClick={close}>
        ×
      </button>
    </aside>
  );
}
