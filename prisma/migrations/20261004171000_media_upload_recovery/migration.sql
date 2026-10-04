-- Reserve storage references before network upload; interrupted uploads stay recoverable.
ALTER TYPE "MediaState" ADD VALUE 'UPLOADING';
