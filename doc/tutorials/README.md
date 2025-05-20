# VoteTorrent Tutorial Scripts

This directory contains scripts for creating tutorial and explainer videos for the VoteTorrent platform. These guidelines will help maintain consistency across all educational content.

## Script Format Guidelines

### 1. Tutorial Goals & Objectives Section

- Begin each script file with a clear **Goals & Objectives** section
- This section is not part of the narration script but provides context for script creators and reviewers
- Include specific learning outcomes the tutorial aims to achieve
- Identify the target audience and their expected knowledge level
- Separate this section from the actual script content with a horizontal rule (---)

### 2. Narrative Structure vs. Outline Format

- **Use narrative scripts** for video narration, not outline format
- Write in complete sentences that flow naturally when spoken aloud
- Avoid bullet points and section headers in the final script
- Focus on conversational language that guides the viewer step-by-step

### 3. Content Optimization

- **Omit introductory content** (users know what video they're watching)
- **Eliminate concluding pleasantries** (no "thank you for watching")
- Begin immediately with substantive content
- Prioritize technical information over filler text
- For multi-length versions, create separate script sections within the same file

### 4. Visual Cues

- Use [SQUARE BRACKETS] to indicate when specific UI elements should be shown
- Place visual cues at the start of the related narration section
- Be specific about what should be displayed (e.g., [SHOW CREATE NETWORK BUTTON])
- Include visualization notes for abstract concepts (e.g., [SHOW NETWORK DIAGRAM])

### 5. Pacing and Transitions

- Include (pause) notes where viewers need time to absorb complex information
- Use (transition) notes to indicate shifts between major concepts
- Keep transition phrases natural and flowing (avoid abrupt topic changes)

### 6. Technical Complexity

- Assume limited technical knowledge from the audience
- Explain specialized terminology when first introduced
- Use analogies to simplify complex concepts (e.g., "think of it as a digital vault")
- Balance technical accuracy with accessibility

## Script Lengths

Each tutorial should have both a comprehensive and condensed version:

1. **Full Version (~500 words)**: Detailed explanation with complete context
2. **Concise Version (~250 words)**: Essential information only

## File Structure

- Each script should be saved as `topic_name.md`
- Include both full and concise versions in the same file
- Begin with a clear title indicating the topic
- Add a Goals & Objectives section before the script content
- Add metadata comments if needed (prerequisites, related features, etc.)

## Example Template

```markdown
# VoteTorrent Tutorial: [Feature Name]

## Tutorial Goals & Objectives

This tutorial aims to:
- [Specific learning outcome 1]
- [Specific learning outcome 2]
- [Specific learning outcome 3]
- [Specific learning outcome 4]

The tutorial targets [describe audience and their expected knowledge level].

---

## Video Narration Script (Full Version - ~500 words)

[SHOW RELEVANT UI ELEMENT]

Initial explanation of the feature's importance and purpose.

(transition)

[SHOW VISUALIZATION]
Detailed explanation of how the feature works.

...additional content...

## Video Narration Script (Concise Version - ~250 words)

[SHOW RELEVANT UI ELEMENT]

Concise explanation of the feature's purpose.

...essential information only...
```

## Best Practices

1. **Accuracy first**: Ensure all technical details are correct
2. **Focus on "why"**: Explain not just how to use features but why they matter
3. **Progressive complexity**: Start with basic concepts, then build to more complex ones
4. **Consistent terminology**: Use the same terms as found in the application
5. **User-centered**: Frame explanations from the user's perspective
6. **Anticipate questions**: Address likely points of confusion proactively

## Recommended Script Development Process

1. Research the feature thoroughly (review documentation and code)
2. Create a content outline to organize key points
3. Draft the Goals & Objectives section to clarify purpose
4. Draft the full version script first
5. Extract the most critical information for the concise version
6. Add visual cues and pacing notes
7. Review for technical accuracy
8. Edit for clarity and natural flow

Following these guidelines will ensure our tutorial content is consistent, efficient, and effectively communicates the necessary information to VoteTorrent users. 