import { useMemo } from 'react';
import type { PublicProjectView } from '../../shared/types';
import { ProjectCard } from './ProjectCard';

interface ProjectGridProps {
  projects: PublicProjectView[];
  onOpen: (slug: string) => void;
  onShared: (message: string) => void;
  skeletonCount?: number;
}

export function ProjectGrid({ projects, onOpen, onShared, skeletonCount = 6 }: ProjectGridProps) {
  const skeletons = useMemo(() => Array.from({ length: skeletonCount }, (_, index) => index), [skeletonCount]);

  if (projects.length === 0) {
    return (
      <div className="project-grid" aria-hidden="true">
        {skeletons.map((index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton-block skeleton-cover" />
            <div className="skeleton-lines">
              <div className="skeleton-block skeleton-line" style={{ width: '68%' }} />
              <div className="skeleton-block skeleton-line" style={{ width: '92%' }} />
              <div className="skeleton-block skeleton-line" style={{ width: '54%' }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="project-grid">
      {projects.map((project) => (
        <ProjectCard key={project.slug} project={project} onOpen={onOpen} onShared={onShared} />
      ))}
    </div>
  );
}
